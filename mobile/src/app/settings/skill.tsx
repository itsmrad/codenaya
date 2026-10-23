import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, StyleSheet, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { Id } from "../../../../convex/_generated/dataModel";
import { Button, Field } from "@/components/form";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { BUILTIN_SKILLS, SKILL_BODY_MAX_LENGTH, validateSkill } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

const EMPTY = { name: "", description: "", body: "" };

/**
 * The web's skill editor as a screen (a skill body is too long for a sheet).
 * `skillId` edits a library skill, `builtin` views one read-only, `from`
 * duplicates a built-in, and no param starts a new skill.
 */
export default function SkillEditor() {
  const c = useColors();
  const { skillId, builtin, from } = useLocalSearchParams<{ skillId?: string; builtin?: string; from?: string }>();
  const skill = useQuery(api.skills.get, skillId ? { skillId: skillId as Id<"skills"> } : "skip");
  const builtinSkill = BUILTIN_SKILLS.find((item) => item.name === (builtin ?? from));

  if (skillId && skill === undefined) return <ActivityIndicator style={styles.flex} color={c.mutedForeground} />;
  const initial = skill ?? (from && builtinSkill ? { ...builtinSkill, name: `${builtinSkill.name}-copy` } : undefined);
  return (
    <SkillForm
      // Remount when the skill loads, so the fields start from it.
      key={skill?._id ?? from ?? "new"}
      skillId={skill?._id}
      initial={builtin && builtinSkill ? builtinSkill : (initial ?? EMPTY)}
      readOnly={Boolean(builtin)}
    />
  );
}

function SkillForm({
  skillId,
  initial,
  readOnly,
}: {
  skillId?: Id<"skills">;
  initial: { name: string; description: string; body: string };
  readOnly: boolean;
}) {
  const c = useColors();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const create = useMutation(api.skills.create);
  const update = useMutation(api.skills.update);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [body, setBody] = useState(initial.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async () => {
    const fields = { name: name.trim(), description: description.trim(), body };
    const problem = validateSkill(fields);
    if (problem) return setError(problem);
    setBusy(true);
    setError(undefined);
    try {
      await (skillId ? update({ skillId, ...fields }) : create(fields));
      router.back();
    } catch (error) {
      setError(errorMessage(error, "Unable to save the skill"));
    } finally {
      setBusy(false);
    }
  };

  const title = readOnly ? "Built-in skill" : skillId ? "Edit skill" : "New skill";
  return (
    <KeyboardAvoidingView style={styles.flex} behavior="padding" keyboardVerticalOffset={headerHeight}>
      <Stack.Screen options={{ title }} />
      <ScrollView
        contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.muted, { color: c.mutedForeground }]}>
          {readOnly
            ? "Built-in skills are read-only. Duplicate one to your library to change it."
            : "The agent sees every enabled skill's name and description, and reads the instructions when a task matches."}
        </Text>
        <Field
          label="Name"
          value={name}
          onChangeText={setName}
          placeholder="seo-metadata"
          editable={!readOnly}
          style={styles.mono}
          hint={readOnly ? undefined : "Lowercase letters, digits and single hyphens."}
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="What the skill does and when the agent should use it."
          editable={!readOnly}
          autoCapitalize="sentences"
          autoCorrect
          multiline
        />
        <Field
          label="Instructions"
          value={body}
          onChangeText={setBody}
          placeholder={"# My skill\n\nRules, a short file skeleton, then pitfalls."}
          editable={!readOnly}
          multiline
          style={[styles.mono, styles.body]}
          hint={readOnly ? undefined : `${body.length.toLocaleString("en-US")} / ${SKILL_BODY_MAX_LENGTH.toLocaleString("en-US")} characters`}
        />
        {error && <Text style={[styles.muted, { color: c.destructive }]}>{error}</Text>}
        {!readOnly && <Button label={busy ? "Saving..." : skillId ? "Save" : "Create skill"} busy={busy} onPress={save} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 14 },
  muted: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  mono: { fontFamily: "monospace", fontSize: 13 },
  body: { minHeight: 240 },
});
