"use client";

import { useParams } from "next/navigation";
import { SkillEditor } from "../_components/SkillEditor";

export default function EditSkillPage() {
  const { id } = useParams<{ id: string }>();
  // Next.js guarantees this segment is present when the route matches
  return <SkillEditor mode="edit" skillId={id!} />;
}
