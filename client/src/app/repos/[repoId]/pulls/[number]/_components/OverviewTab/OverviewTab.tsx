"use client";

import React from "react";
import { useParams } from "next/navigation";
import { SectionLabel } from "@devdigest/ui";
import { PrBriefCard } from "./_components/PrBriefCard";
import { IntentCard } from "./_components/IntentCard";
import { WhyRiskBriefCard } from "./_components/WhyRiskBriefCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  prBody: string | null | undefined;
}

export function OverviewTab({ prId, prBody }: OverviewTabProps) {
  // Route params for the Review-focus deep-link target — mirrors the
  // `/repos/:repoId/pulls/:number` shape `FindingsCell` links into.
  const params = useParams<{ repoId: string; number: string }>();
  const baseHref = `/repos/${params.repoId}/pulls/${params.number}`;

  return (
    <>
      <PrBriefCard prId={prId} />
      <IntentCard prId={prId} />
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
