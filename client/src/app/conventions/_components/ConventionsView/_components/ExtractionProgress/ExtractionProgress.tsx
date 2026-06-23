"use client";

interface Props { message: string | null; }

export function ExtractionProgress({ message }: Props) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 6,
      background: "var(--bg-elevated)", border: "1px solid var(--border)",
      marginBottom: 16, fontSize: 13, color: "var(--text-secondary)",
    }}>
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        border: "2px solid var(--accent)", borderTopColor: "transparent",
        animation: "ddConvSpin 0.8s linear infinite", flexShrink: 0,
      }} />
      <style>{`@keyframes ddConvSpin { to { transform: rotate(360deg); } }`}</style>
      {message ?? "Analyzing…"}
    </div>
  );
}
