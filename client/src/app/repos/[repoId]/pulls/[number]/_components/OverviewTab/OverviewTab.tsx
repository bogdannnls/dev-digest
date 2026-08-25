"use client";

import React from "react";
import { useParams } from "next/navigation";
import { SectionLabel } from "@devdigest/ui";
import type { RepoProvider } from "@devdigest/shared";
import { PrBriefCard } from "./_components/PrBriefCard";
import { IntentCard } from "./_components/IntentCard";
import { WhyRiskBriefCard } from "./_components/WhyRiskBriefCard";
import { BlastRadiusCard } from "./_components/BlastRadiusCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  prBody: string | null | undefined;
  repoId: string;
  repoFullName: string | null;
  headSha: string | null;
  provider: RepoProvider | null;
}

export function OverviewTab({ prId, prBody, repoId, repoFullName, headSha, provider }: OverviewTabProps) {
  // Route params for the Review-focus deep-link target — mirrors the
  // `/repos/:repoId/pulls/:number` shape `FindingsCell` links into.
  const params = useParams<{ repoId: string; number: string }>();
  const baseHref = `/repos/${params.repoId}/pulls/${params.number}`;

  return (
    <>
      <PrBriefCard prId={prId} />
      <div style={s.twoCol}>
        <IntentCard prId={prId} />
        <BlastRadiusCard
          prId={prId}
          repoId={repoId}
          repoFullName={repoFullName}
          headSha={headSha}
          provider={provider}
        />
      </div>
      {/* Synthesis card: reads over intent + blast + findings, so it renders
          full-width below the two inputs it summarizes. */}
      <WhyRiskBriefCard prId={prId} baseHref={baseHref} />
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
