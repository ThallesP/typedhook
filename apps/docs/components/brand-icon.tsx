import type { SimpleIcon } from "simple-icons";

export type BrandIconProps = {
  icon: SimpleIcon;
  className?: string;
};

export function BrandIcon({ icon, className }: BrandIconProps) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" aria-label={icon.title} className={className}>
      <path d={icon.path} />
    </svg>
  );
}
