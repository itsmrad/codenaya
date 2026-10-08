import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";

import type { SkillSource } from "../types";

const SOURCE_LABELS: Record<SkillSource, string> = {
  builtin: "Built-in",
  user: "Custom",
  github: "GitHub",
};

interface SkillCardProps {
  name: string;
  description: string;
  source: SkillSource;
  /** Extra details under the description, such as where it is used. */
  meta?: React.ReactNode;
  /** Buttons on the right; they wrap below the details on phones. */
  actions: React.ReactNode;
}

/** One skill in the Settings → Skills gallery. */
export const SkillCard = ({
  name,
  description,
  source,
  meta,
  actions,
}: SkillCardProps) => (
  <Item role="listitem" aria-label={name} variant="outline" size="sm">
    <ItemContent className="min-w-56">
      <ItemTitle className="w-full min-w-0">
        <span className="truncate font-mono">{name}</span>
        <Badge variant="secondary">{SOURCE_LABELS[source]}</Badge>
      </ItemTitle>
      <ItemDescription>{description}</ItemDescription>
      {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
    </ItemContent>
    <ItemActions>{actions}</ItemActions>
  </Item>
);
