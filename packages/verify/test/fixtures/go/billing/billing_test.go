package billing_test

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"
	"time"

	"example.com/hooks/billing"
)

type signedCase struct {
	Name             string            `json:"name"`
	Body             string            `json:"body"`
	Headers          map[string]string `json:"headers"`
	Secret           string            `json:"secret"`
	ToleranceSeconds int64             `json:"toleranceSeconds"`
	Reason           string            `json:"reason"`
}

func TestVerify(t *testing.T) {
	path := os.Getenv("TYPEDHOOK_CASES")
	if path == "" {
		t.Skip("go.test.ts signs the cases and passes their path in TYPEDHOOK_CASES")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var cases []signedCase
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, c := range cases {
		t.Run(c.Name, func(t *testing.T) {
			header := http.Header{}
			for name, value := range c.Headers {
				header.Set(name, value)
			}
			event, err := verify(c, header)
			if c.Reason == "" {
				if err != nil {
					t.Fatalf("got %v, want no error", err)
				}
				if _, ok := event.(*billing.InvoicePaid); !ok {
					t.Fatalf("got %T, want *billing.InvoicePaid", event)
				}
				return
			}
			var verifyErr *billing.Error
			if !errors.As(err, &verifyErr) || string(verifyErr.Reason) != c.Reason {
				t.Fatalf("got %v, want %s", err, c.Reason)
			}
		})
	}
}

func verify(c signedCase, header http.Header) (billing.Event, error) {
	if c.ToleranceSeconds == 0 {
		return billing.Verify([]byte(c.Body), header, c.Secret)
	}
	verifier := billing.Verifier{Secret: c.Secret, Tolerance: time.Duration(c.ToleranceSeconds) * time.Second}
	return verifier.Verify([]byte(c.Body), header)
}

func TestParseDecodesEachEvent(t *testing.T) {
	event := parse(t, `{"event":"invoice.paid","subject":null,"data":{"invoiceId":"in_1","amountCents":4200,"paidAt":"2026-01-01T00:00:00Z","lines":[{"sku":"seat","quantity":3}]}}`)
	paid, ok := event.(*billing.InvoicePaid)
	if !ok || paid.Subject != nil || paid.Data.InvoiceID != "in_1" || paid.Data.AmountCents != 4200 {
		t.Fatalf("got %#v", event)
	}
	if len(paid.Data.Lines) != 1 || paid.Data.Lines[0].Sku != "seat" || paid.Data.Lines[0].Quantity != 3 {
		t.Fatalf("got lines %#v", paid.Data.Lines)
	}

	voided, ok := parse(t, `{"event":"invoice.voided","subject":"cus_1","data":{"invoiceId":"in_1","reason":"fraudulent"}}`).(*billing.InvoiceVoided)
	if !ok || *voided.Subject != "cus_1" || *voided.Data.Reason != billing.InvoiceVoidedDataReasonFraudulent {
		t.Fatalf("got %#v", voided)
	}
	unexplained, ok := parse(t, `{"event":"invoice.voided","subject":null,"data":{"invoiceId":"in_1","reason":null}}`).(*billing.InvoiceVoided)
	if !ok || unexplained.Data.Reason != nil {
		t.Fatalf("got %#v", unexplained)
	}

	category, ok := parse(t, `{"event":"category.created","subject":null,"data":{"name":"shoes","parent":{"name":"clothes"}}}`).(*billing.CategoryCreated)
	if !ok || category.Data.Name != "shoes" || category.Data.Parent.Name != "clothes" || category.Data.Parent.Parent != nil {
		t.Fatalf("got %#v", category)
	}

	price, ok := parse(t, `{"event":"price.created","subject":null,"data":{"priceId":"pr_1","tiers":{"upTo":10,"unitAmountCents":500,"next":{"upTo":null,"unitAmountCents":400}}}}`).(*billing.PriceCreated)
	if !ok || *price.Data.Tiers.UpTo != 10 || price.Data.Tiers.Next.UpTo != nil || price.Data.Tiers.Next.UnitAmountCents != 400 {
		t.Fatalf("got %#v", price)
	}

	customer, ok := parse(t, `{"event":"customer.updated","subject":null,"data":{"customerId":"cus_1","metadata":{"plan":"pro"}}}`).(*billing.CustomerUpdated)
	if !ok || customer.Data.Email != nil || customer.Data.Metadata["plan"] != "pro" {
		t.Fatalf("got %#v", customer)
	}

	usage, ok := parse(t, `{"event":"usage.recorded","subject":null,"data":{"meter":["api",1.5],"readings":["api",1,2]}}`).(*billing.UsageRecorded)
	if !ok || len(usage.Data.Meter) != 2 || string(usage.Data.Meter[1]) != "1.5" || len(usage.Data.Readings) != 3 {
		t.Fatalf("got %#v", usage)
	}
}

func TestParseKeepsUnknownEvents(t *testing.T) {
	payload := `{"event":"invoice.refunded","data":{}}`
	unknown, ok := parse(t, payload).(*billing.UnknownEvent)
	if !ok || unknown.Name != "invoice.refunded" || string(unknown.Raw) != payload {
		t.Fatalf("got %#v", unknown)
	}
	unnamed, ok := parse(t, `{"event":7}`).(*billing.UnknownEvent)
	if !ok || unnamed.Name != "" {
		t.Fatalf("got %#v", unnamed)
	}
}

func TestParseRejectsInvalidPayloads(t *testing.T) {
	for _, payload := range []string{`not json`, `[1]`, `{"event":"invoice.paid","subject":null,"data":{"amountCents":"many"}}`} {
		_, err := billing.Parse([]byte(payload))
		var parseErr *billing.Error
		if !errors.As(err, &parseErr) || parseErr.Reason != billing.ReasonInvalidJSON || parseErr.Err == nil {
			t.Fatalf("%s: got %v, want invalid_json", payload, err)
		}
	}
}

func parse(t *testing.T, payload string) billing.Event {
	t.Helper()
	event, err := billing.Parse([]byte(payload))
	if err != nil {
		t.Fatal(err)
	}
	return event
}
