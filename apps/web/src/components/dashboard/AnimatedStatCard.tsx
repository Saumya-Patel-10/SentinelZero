import React from "react";
import { motion, useReducedMotion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

export type StatCardTone = "cyan" | "green" | "amber" | "red" | "violet";

export type StatCardProps = {
  title: string;
  value: string | number;
  change?: string;
  icon: LucideIcon;
  tone?: StatCardTone;
  onClick?: () => void;
  lastUpdated?: string;
  sublabel?: string;
};

const toneClasses: Record<StatCardTone, string> = {
  cyan: "from-cyan-500/15 via-slate-900/50 to-slate-950/60 border-cyan-400/25",
  green: "from-lime-500/15 via-slate-900/50 to-slate-950/60 border-lime-400/25",
  amber: "from-amber-500/15 via-slate-900/50 to-slate-950/60 border-amber-400/25",
  red: "from-red-500/15 via-slate-900/50 to-slate-950/60 border-red-400/25",
  violet: "from-purple-500/15 via-slate-900/50 to-slate-950/60 border-purple-400/25",
};

export function AnimatedStatCard({
  title,
  value,
  change,
  icon: Icon,
  tone = "cyan",
  onClick,
  lastUpdated,
  sublabel,
}: StatCardProps) {
  const reducedMotion = useReducedMotion();
  const interactive = typeof onClick === "function";

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={interactive && !reducedMotion ? { y: -3, scale: 1.01 } : undefined}
      transition={{ duration: reducedMotion ? 0 : 0.26, ease: "easeOut" }}
      className={`relative overflow-hidden rounded-2xl border bg-gradient-to-br p-5 shadow-sm ${toneClasses[tone]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-300">{title}</p>
          <p
            className="mt-2 text-3xl font-semibold tracking-tight tabular-nums text-white"
            aria-live="polite"
          >
            {value}
          </p>
          {sublabel && <p className="mt-1 text-xs text-slate-400 truncate">{sublabel}</p>}
        </div>
        <div className="rounded-xl border border-white/10 bg-white/5 p-2.5 text-slate-100" aria-hidden="true">
          <Icon size={20} strokeWidth={1.8} />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <p className="text-xs text-slate-300">{change ?? "Current verified value"}</p>
        {interactive && (
          <button
            type="button"
            onClick={onClick}
            className="rounded-md px-2 py-1 text-xs font-semibold text-cyan-200 outline-offset-2 hover:bg-white/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-300 transition-colors"
            aria-label={`View details for ${title}`}
          >
            Details
          </button>
        )}
      </div>
      {lastUpdated && <p className="mt-2 text-[11px] text-slate-400">Updated {lastUpdated}</p>}
    </motion.div>
  );
}
