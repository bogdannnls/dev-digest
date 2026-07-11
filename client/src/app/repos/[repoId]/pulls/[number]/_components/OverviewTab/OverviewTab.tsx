"use client";

import React from "react";
import { SectionLabel } from "@devdigest/ui";
import { PrBriefCard } from "./_components/PrBriefCard";
import { IntentCard } from "./_components/IntentCard";
import { BlastRadiusCard } from "./_components/BlastRadiusCard";
import { s } from "./styles";

interface OverviewTabProps {
  prId: string | null;
  prBody: string | null | undefined;
  repoId: string;
  repoFullName: string | null;
  headSha: string | null;
}

export function OverviewTab({ prId, prBody, repoId, repoFullName, headSha }: OverviewTabProps) {
  return (
    <>
      <PrBriefCard prId={prId} />
      <div style={s.twoCol}>
        <IntentCard prId={prId} />
        <BlastRadiusCard prId={prId} repoId={repoId} repoFullName={repoFullName} headSha={headSha} />
      </div>
      {prBody && (
        <section>
          <SectionLabel icon="MessageSquare">Description</SectionLabel>
          <div style={s.descriptionBox}>{prBody}</div>
        </section>
      )}
    </>
  );
}
