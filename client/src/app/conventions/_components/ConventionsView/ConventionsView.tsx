"use client";

import React from "react";
import { AppShell } from "../../../../components/app-shell";
import { EmptyState, ErrorState, Skeleton, Button } from "@devdigest/ui";
import { useConventions, useExtractConventions } from "../../../../lib/hooks/conventions";
import { useRepos } from "../../../../lib/hooks/core";
import { ConventionCard } from "./_components/ConventionCard/ConventionCard";
import { ExtractionProgress } from "./_components/ExtractionProgress/ExtractionProgress";
import { CreateSkillsModal } from "./_components/CreateSkillsModal/CreateSkillsModal";

export function ConventionsView() {
  const { data: repos } = useRepos();
  const [repoId, setRepoId] = React.useState<string | null>(null);
  const [showModal, setShowModal] = React.useState(false);

  const { data, isLoading, isError, refetch } = useConventions(repoId);
  const { extract, extracting, progress } = useExtractConventions(repoId ?? "");

  const candidates = data?.candidates ?? [];
  const acceptedCount = candidates.filter((c) => c.accepted).length;
  const selectedRepo = repos?.find((r: { id: string }) => r.id === repoId);
  const hasScanned = (data?.scanned_at ?? null) !== null;

  return (
    <AppShell crumb={[{ label: "Skills Lab" }, { label: "Conventions" }]}>
      <div style={{ padding: "24px 32px", maxWidth: 900 }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
          <h1 style={{ fontSize: 24, fontWeight: 700, flex: 1 }}>
            Conventions{selectedRepo ? ` in ${selectedRepo.name}` : ""}
          </h1>
          <select
            value={repoId ?? ""}
            onChange={(e) => setRepoId(e.target.value || null)}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}
          >
            <option value="">Select repo…</option>
            {repos?.map((r: { id: string; owner: string; name: string }) => (
              <option key={r.id} value={r.id}>{r.owner}/{r.name}</option>
            ))}
          </select>
          <Button
            kind="secondary"
            disabled={!repoId || extracting}
            onClick={() => extract()}
          >
            {extracting ? "Scanning…" : hasScanned ? "Re-scan" : "Scan"}
          </Button>
        </div>

        {data?.scanned_at && (
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
            Detected from {candidates.length} candidates · last scan {new Date(data.scanned_at).toLocaleString()}
          </p>
        )}

        {extracting && <ExtractionProgress message={progress} />}

        {candidates.length > 0 && !extracting && (
          <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {acceptedCount} of {candidates.length} accepted
            </span>
            <div style={{ flex: 1 }} />
            <Button
              kind="primary"
              disabled={acceptedCount === 0}
              onClick={() => setShowModal(true)}
            >
              Create {acceptedCount} skill{acceptedCount !== 1 ? "s" : ""} ✦
            </Button>
          </div>
        )}

        {!repoId && (
          <EmptyState icon="ListChecks" title="Select a repo to scan" body="Choose a connected repository to extract coding conventions from." />
        )}
        {repoId && isLoading && <Skeleton height={120} />}
        {repoId && isError && (
          <ErrorState body="Failed to load conventions" onRetry={() => refetch()} />
        )}
        {repoId && !isLoading && !isError && !extracting && candidates.length === 0 && (
          <EmptyState icon="Sparkles" title="No conventions yet" body="Click Scan to analyze this repository and extract coding conventions." />
        )}

        {candidates.map((c) => (
          <ConventionCard key={c.id} candidate={c} repoId={repoId!} />
        ))}
      </div>

      {showModal && repoId && selectedRepo && (
        <CreateSkillsModal
          repoId={repoId}
          repoSlug={`${selectedRepo.owner}-${selectedRepo.name}`}
          candidates={candidates.filter((c) => c.accepted)}
          onClose={() => setShowModal(false)}
        />
      )}
    </AppShell>
  );
}
