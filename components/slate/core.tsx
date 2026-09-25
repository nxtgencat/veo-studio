import * as React from "react";
import { cn } from "cn";
import { Search, Upload, X } from "lucide-react";
import { SlateIconButton } from "@/components/slate/button";

export function SlateCard({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("slate-card", className)} {...props} />;
}

export function SlateCardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between gap-3 px-4 h-11 border-b slate-hair", className)}
      {...props}
    />
  );
}

export function SlateField({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("slate-field", className)} {...props} />;
}

export function SlateTextarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("slate-field", className)} {...props} />;
}

export function SlateLabel({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("slate-lbl", className)} {...props} />;
}

export function SlateProgress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn("slate-prog", className)} role="progressbar" aria-valuenow={Math.round(value)}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function SlateToggle({
  on,
  onFlip,
  label,
  disabled,
}: {
  on: boolean;
  onFlip: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label || "toggle"}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onFlip();
      }}
      style={disabled ? { opacity: 0.4 } : undefined}
      className={`slate-tgl ${on ? "on" : ""}`}
    >
      <span className="knob" />
    </button>
  );
}

export function SlateEmpty({
  icon,
  title,
  sub,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="slate-card p-10 text-center">
      <div className="slate-tile-icon w-14 h-14 rounded-full mx-auto mb-4">
        {icon}
      </div>
      <h3 className="font-display font-bold text-[17px]">{title}</h3>
      <p className="text-[13px] text-fg2 mt-1.5 max-w-[40ch] mx-auto">{sub}</p>
      {action && <div className="mt-4 flex gap-2 justify-center flex-wrap">{action}</div>}
    </div>
  );
}

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div className="min-w-0">
        <h1 className="font-display font-bold text-[20px] tracking-[-.015em]">{title}</h1>
        {sub && <p className="mt-1 text-[13px] text-fg2 max-w-[62ch] leading-relaxed">{sub}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0 flex-wrap">{actions}</div>
    </div>
  );
}

/**
 * Pill segmented control — one primitive for every tab row
 * (library status filter, elements categories). shadcn tabs.tsx parity:
 * list container + active trigger highlight, roving via buttons.
 */
export function SlateSegmented<T extends string>({
  options,
  value,
  onChange,
  label,
  scrollable,
  className,
}: {
  options: readonly { id: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
  scrollable?: boolean;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex gap-1 p-1 rounded-[12px] border slate-hair max-w-full bg-surface2",
        scrollable && "overflow-x-auto no-scrollbar",
        className,
      )}
    >
      {options.map((o) => {
        const on = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.id)}
            className={cn(
              "flex items-center gap-1.5 px-3 h-[30px] rounded-[8px] text-[12.5px] font-bold whitespace-nowrap transition-colors",
              on ? "bg-surface text-[var(--t-brand-fg)]" : "text-fg2 hover:bg-surface2",
            )}
            style={on ? { boxShadow: "0 1px 2px rgba(0,0,0,.08)" } : undefined}
          >
            {o.label}
            {o.count != null && <span className="font-mono text-[11px] opacity-70">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** Search field with leading icon + clear button — picker dialogs share one. */
export function SlateSearchField({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
}) {
  return (
    <div className="relative">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none">
        <Search className="size-3.5" />
      </span>
      <SlateField
        className="!pl-8 !pr-8 !min-h-[34px] !text-[12.5px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "Search by name…"}
        autoComplete="off"
        aria-label={label ?? placeholder ?? "Search"}
      />
      {value && (
        <SlateIconButton
          size="icon-2xs"
          variant="quiet"
          label="Clear search"
          onClick={() => onChange("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2"
        >
          <X />
        </SlateIconButton>
      )}
    </div>
  );
}

/** Dashed upload tile — image/video pickers share one (label + hidden input). */
export function SlateUploadCard({
  title,
  sub,
  accept,
  busy,
  busyTitle,
  onFile,
  className,
}: {
  title: string;
  sub: string;
  accept: string;
  busy?: boolean;
  busyTitle?: string;
  onFile: (f: File) => void;
  className?: string;
}) {
  return (
    <label className={cn("slate-card slate-upload-card p-3 flex items-center gap-2.5 cursor-pointer hover:border-[#3FA96D] transition-colors", className)}>
      <span className="slate-tile-icon w-9 h-9 rounded-[9px]">
        <Upload className="size-4" />
      </span>
      <span>
        <span className="block text-[13px] font-bold">{busy ? (busyTitle ?? "Uploading…") : title}</span>
        <span className="block text-[11.5px] text-muted">{sub}</span>
      </span>
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </label>
  );
}
