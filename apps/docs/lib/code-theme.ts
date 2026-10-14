export const codeTheme = {
  name: "webhooks-night",
  type: "dark" as const,
  colors: {
    "editor.background": "#0D0D10",
    "editor.foreground": "#D4D4D8",
  },
  settings: [
    { settings: { foreground: "#D4D4D8", background: "#0D0D10" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#5A5A63", fontStyle: "italic" },
    },
    {
      scope: [
        "keyword",
        "storage",
        "storage.type",
        "storage.modifier",
        "constant.language",
        "variable.language",
      ],
      settings: { foreground: "#A0A0A8" },
    },
    {
      scope: [
        "keyword.operator",
        "keyword.operator.assignment",
        "keyword.operator.arithmetic",
        "keyword.operator.logical",
        "keyword.operator.comparison",
        "keyword.operator.relational",
        "keyword.operator.type.annotation",
        "keyword.operator.optional",
        "keyword.operator.rest",
        "keyword.operator.spread",
      ],
      settings: { foreground: "#D4D4D8" },
    },
    {
      scope: [
        "string",
        "string.template",
        "punctuation.definition.string",
        "support.type.property-name.json",
        "punctuation.support.type.property-name",
      ],
      settings: { foreground: "#99FFE4" },
    },
    {
      scope: ["punctuation.definition.template-expression", "meta.template.expression"],
      settings: { foreground: "#D4D4D8" },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "meta.function-call entity.name.function",
      ],
      settings: { foreground: "#FFC799" },
    },
    {
      scope: ["meta.object-literal.key entity.name.function"],
      settings: { foreground: "#D4D4D8" },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
        "variable.other.readwrite.alias",
      ],
      settings: { foreground: "#C4C4CA" },
    },
    {
      scope: ["constant.numeric", "variable.other.constant.property", "variable.other.enummember"],
      settings: { foreground: "#F2A0A0" },
    },
    {
      scope: ["entity.name.command", "support.function.builtin.shell", "string.unquoted.argument.shell"],
      settings: { foreground: "#D4D4D8" },
    },
  ],
};
