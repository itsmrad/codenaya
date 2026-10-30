import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Field } from "@/components/form";
import { LabelStrip, monoLabel } from "@/components/grid";
import { ChevronRight, Copy, Download, Eye, Pencil, Plus, Search, Sparkles } from "@/components/icons";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { postApi } from "@/lib/http";
import { BUILTIN_SKILL_ATTRIBUTIONS, BUILTIN_SKILLS } from "@/lib/shared";
import { font, useColors } from "@/lib/theme";

const matches = (skill: { name: string; description: string }, search: string) => {
  const needle = search.trim().toLowerCase();
  return !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
};

const projectCountLabel = (count: number) =>
  count === 0 ? "Not enabled in any project" : `${count} ${count === 1 ? "project" : "projects"}`;

type ImportedSkill = { name: string; description: string; body: string; sourceUrl: string };

/**
 * The web's Import skill dialog: fetch a SKILL.md from a GitHub or skills.sh
 * URL, preview it (it is third-party text), and save only on confirm.
 */
function ImportSkillSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const c = useColors();
  const { getToken } = useAuth();
  const createSkill = useMutation(api.skills.create);
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportedSkill>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const close = () => {
    setUrl("");
    setPreview(undefined);
    setError(undefined);
    onClose();
  };

  const fetchPreview = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { ok, data } = await postApi<{ skill: ImportedSkill }>("/api/skills/import", { url: url.trim() }, getToken);
      if (ok) setPreview(data.skill);
      else setError(data.error ?? "Failed to import the skill");
    } catch {
      setError("Couldn't reach Codenaya. Is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      await createSkill(preview);
      close();
    } catch (error) {
      setError(errorMessage(error, `Unable to import ${preview.name}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      visible={visible}
      title="Import a skill"
      description="Paste a GitHub folder with a SKILL.md, or a skills.sh link."
      onClose={close}
    >
      <View style={styles.form}>
        {preview ? (
          <>
            <Text style={[styles.name, { color: c.foreground }]}>{preview.name}</Text>
            <Text style={[styles.muted, { color: c.mutedForeground }]}>{preview.description}</Text>
            <Pressable onPress={() => WebBrowser.openBrowserAsync(preview.sourceUrl)}>
              <Text style={[styles.link, { color: c.brandText }]} numberOfLines={1}>
                {preview.sourceUrl}
              </Text>
            </Pressable>
            <ScrollView style={[styles.preview, { borderColor: c.border }]} nestedScrollEnabled>
              <Text style={[styles.code, { color: c.foreground }]}>{preview.body || "No instructions."}</Text>
            </ScrollView>
            {error && <Text style={[styles.muted, { color: c.destructive }]}>{error}</Text>}
            <Button label="Import" busy={busy} onPress={save} />
            <Button label="Back" variant="outline" onPress={() => setPreview(undefined)} />
          </>
        ) : (
          <>
            <Field
              label="Skill URL"
              value={url}
              onChangeText={setUrl}
              placeholder="https://github.com/owner/repo/tree/main/skills/name"
              keyboardType="url"
            />
            {error && <Text style={[styles.muted, { color: c.destructive }]}>{error}</Text>}
            <Button label={busy ? "Fetching..." : "Preview"} busy={busy} disabled={!url.trim()} onPress={fetchPreview} />
          </>
        )}
      </View>
    </Sheet>
  );
}

/**
 * The web's Settings > Skills: the built-in skills (view, duplicate) and the
 * user's library (new, import, edit, delete), as grid sections. Library skills
 * are enabled per project from the project's Skills panel.
 */
export default function SkillsSettings() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const library = useQuery(api.skills.listLibrary);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  // The built-in skill whose View / Duplicate sheet is open.
  const [builtinName, setBuiltinName] = useState<string>();

  const openEditor = (params: Record<string, string> = {}) => router.push({ pathname: "/settings/skill", params });
  const builtins = BUILTIN_SKILLS.filter((skill) => matches(skill, search));
  const shown = library?.filter((skill) => matches(skill, search));
  const attribution = builtinName ? BUILTIN_SKILL_ATTRIBUTIONS[builtinName] : undefined;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => setMenuOpen(true)} hitSlop={10} accessibilityLabel="Add a skill">
              <Plus size={20} color={c.foreground} />
            </Pressable>
          ),
        }}
      />
      <View style={[styles.search, { backgroundColor: c.card, borderColor: c.border }]}>
        <Search size={17} color={c.mutedForeground} />
        <TextInput
          style={[styles.searchInput, { color: c.foreground }]}
          value={search}
          onChangeText={setSearch}
          placeholder="Search skills"
          placeholderTextColor={c.mutedForeground}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>

      <View style={[styles.section, styles.first, { backgroundColor: c.card, borderColor: c.border }]}>
        <LabelStrip label="Built-in" />
        {builtins.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground, borderColor: c.border }]}>
            No built-in skills match "{search.trim()}".
          </Text>
        ) : (
          builtins.map((skill) => (
            <Pressable
              key={skill.name}
              onPress={() => setBuiltinName(skill.name)}
              accessibilityLabel={`${skill.name} options`}
              style={({ pressed }) => [styles.row, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
            >
              <View style={[styles.tile, { borderColor: c.border, backgroundColor: c.background }]}>
                <Sparkles size={18} color={c.brandText} />
              </View>
              <View style={styles.flex}>
                <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                  {skill.name}
                </Text>
                <Text style={[styles.description, { color: c.mutedForeground }]} numberOfLines={1}>
                  {skill.description}
                </Text>
              </View>
              <Text style={[monoLabel, styles.tag, { color: c.mutedForeground, borderColor: c.border }]}>Built-in</Text>
            </Pressable>
          ))
        )}
      </View>

      <View style={[styles.section, { backgroundColor: c.card, borderColor: c.border }]}>
        <LabelStrip
          label="Your library"
          cell={<Text style={[monoLabel, { color: c.mutedForeground }]}>{library?.length ?? 0}</Text>}
        />
        {shown === undefined ? (
          <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
        ) : library?.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground, borderColor: c.border }]}>
            No skills in your library yet. Write a skill once and enable it in any project: conventions, recipes or
            checklists the agent should follow.
          </Text>
        ) : shown.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground, borderColor: c.border }]}>
            No skills match "{search.trim()}".
          </Text>
        ) : (
          shown.map((skill) => (
            <Pressable
              key={skill._id}
              onPress={() => openEditor({ skillId: skill._id })}
              accessibilityLabel={`Edit ${skill.name}`}
              style={({ pressed }) => [styles.row, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
            >
              <View style={styles.flex}>
                <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
                  {skill.name}
                </Text>
                <Text style={[styles.description, { color: c.mutedForeground }]} numberOfLines={2}>
                  {skill.description}
                </Text>
                <Text style={[monoLabel, styles.meta, { color: c.mutedForeground }]}>
                  {projectCountLabel(skill.projectCount)}
                </Text>
              </View>
              <ChevronRight size={16} color={c.mutedForeground} />
            </Pressable>
          ))
        )}
      </View>
      <Text style={[styles.note, { color: c.mutedForeground }]}>
        Library skills are off in every project until you enable them in that project's Skills.
      </Text>

      <Sheet visible={menuOpen} title="Add a skill" onClose={() => setMenuOpen(false)}>
        <SheetRow
          icon={<Download size={18} color={c.foreground} />}
          label="Import"
          detail="From GitHub or skills.sh"
          onPress={() => {
            setMenuOpen(false);
            setImportOpen(true);
          }}
        />
        <SheetRow
          icon={<Pencil size={18} color={c.foreground} />}
          label="New skill"
          detail="Write the instructions yourself"
          onPress={() => {
            setMenuOpen(false);
            openEditor();
          }}
        />
      </Sheet>
      <Sheet
        visible={builtinName !== undefined}
        title={builtinName ?? ""}
        description={
          attribution
            ? `Read-only, ships with Codenaya. Adapted from ${attribution.label} · ${attribution.license} license.`
            : "Read-only, ships with Codenaya. Duplicate it to change it."
        }
        onClose={() => setBuiltinName(undefined)}
      >
        <SheetRow
          icon={<Eye size={18} color={c.foreground} />}
          label="View"
          onPress={() => {
            setBuiltinName(undefined);
            if (builtinName) openEditor({ builtin: builtinName });
          }}
        />
        <SheetRow
          icon={<Copy size={18} color={c.foreground} />}
          label="Duplicate to your library"
          onPress={() => {
            setBuiltinName(undefined);
            if (builtinName) openEditor({ from: builtinName });
          }}
        />
      </Sheet>
      <ImportSkillSheet visible={importOpen} onClose={() => setImportOpen(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  muted: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  meta: { fontSize: 9, marginTop: 6 },
  link: { fontSize: 12, fontFamily: font.regular },
  loading: { paddingVertical: 16 },
  empty: { padding: 16, borderBottomWidth: 1, fontSize: 13, lineHeight: 19, fontFamily: font.regular },
  search: { flexDirection: "row", alignItems: "center", gap: 12, height: 48, paddingHorizontal: 16, borderBottomWidth: 1 },
  searchInput: { flex: 1, fontSize: 15, fontFamily: font.regular, paddingVertical: 0 },
  section: { marginTop: 20, borderTopWidth: 1 },
  first: { marginTop: 0, borderTopWidth: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  tile: { width: 36, height: 36, borderRadius: 6, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  name: { fontSize: 14, fontFamily: font.monoMedium },
  description: { fontSize: 13, lineHeight: 18, fontFamily: font.regular, marginTop: 2 },
  tag: { fontSize: 9, borderWidth: 1, borderRadius: 2, paddingHorizontal: 6, paddingVertical: 2 },
  note: { padding: 16, fontSize: 12.5, lineHeight: 18, fontFamily: font.regular },
  form: { gap: 12, padding: 12 },
  preview: { maxHeight: 220, borderWidth: 1, borderRadius: 6, padding: 10 },
  code: { fontFamily: font.mono, fontSize: 12, lineHeight: 18 },
});
