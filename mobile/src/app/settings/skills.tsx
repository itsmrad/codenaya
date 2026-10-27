import { useAuth } from "@clerk/expo";
import { useMutation, useQuery } from "convex/react";
import { Stack, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { type ReactNode, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import type { Id } from "../../../../convex/_generated/dataModel";
import { confirm, toast } from "@/components/dialogs";
import { Button, Field } from "@/components/form";
import { Copy, Download, Eye, Info, Pencil, Plus, Search, Sparkles, Trash2 } from "@/components/icons";
import { Sheet, SheetRow } from "@/components/sheet";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { postApi } from "@/lib/http";
import { BUILTIN_SKILL_ATTRIBUTIONS, BUILTIN_SKILLS } from "@/lib/shared";
import { type Colors, font, radius, useColors } from "@/lib/theme";

const matches = (skill: { name: string; description: string }, search: string) => {
  const needle = search.trim().toLowerCase();
  return !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle);
};

const projectCountLabel = (count: number) =>
  count === 0 ? "Not enabled in any project" : `Used in ${count} ${count === 1 ? "project" : "projects"}`;

/** Like the web's SkillCard: name, description, a meta line and actions. */
function SkillCard({
  name,
  description,
  meta,
  actions,
  c,
}: {
  name: string;
  description: string;
  meta?: ReactNode;
  actions: ReactNode;
  c: Colors;
}) {
  return (
    <View style={[styles.skill, { borderColor: c.border }]}>
      <Text style={[styles.name, { color: c.foreground }]}>{name}</Text>
      <Text style={[styles.muted, { color: c.mutedForeground }]} numberOfLines={3}>
        {description}
      </Text>
      {meta && <Text style={[styles.meta, { color: c.mutedForeground }]}>{meta}</Text>}
      <View style={styles.actions}>{actions}</View>
    </View>
  );
}

function Action({ label, icon, onPress, c }: { label: string; icon: ReactNode; onPress: () => void; c: Colors }) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.action, { borderColor: c.border }, pressed && { backgroundColor: c.muted }]}
    >
      {icon}
      <Text style={[styles.actionText, { color: c.foreground }]}>{label}</Text>
    </Pressable>
  );
}

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
              <Text style={[styles.meta, { color: c.brandText }]} numberOfLines={1}>
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
 * user's library (new, import, edit, delete). Library skills are enabled per
 * project from the project's Skills panel.
 */
export default function SkillsSettings() {
  const c = useColors();
  const router = useRouter();
  const library = useQuery(api.skills.listLibrary);
  const removeSkill = useMutation(api.skills.remove);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const openEditor = (params: Record<string, string> = {}) => router.push({ pathname: "/settings/skill", params });
  const confirmDelete = async (skill: { _id: Id<"skills">; name: string }) => {
    const confirmed = await confirm({
      title: `Delete ${skill.name}?`,
      message: "It is removed from your library and every project that uses it.",
      confirmLabel: "Delete skill",
      destructive: true,
    });
    if (!confirmed) return;
    removeSkill({ skillId: skill._id }).catch((error) => toast.error(errorMessage(error, `Unable to delete ${skill.name}`)));
  };

  const builtins = BUILTIN_SKILLS.filter((skill) => matches(skill, search));
  const shown = library?.filter((skill) => matches(skill, search));

  return (
    <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable onPress={() => setMenuOpen(true)} hitSlop={10} accessibilityLabel="Add a skill">
              <Plus size={20} color={c.foreground} />
            </Pressable>
          ),
        }}
      />
      <View style={[styles.card, styles.notice, { backgroundColor: c.card, borderColor: c.border }]}>
        <Info size={16} color={c.foreground} />
        <View style={styles.flex}>
          <Text style={[styles.title, { color: c.foreground }]}>
            Library skills are off in every project until you enable them
          </Text>
          <Text style={[styles.muted, { color: c.mutedForeground }]}>
            Open a project's Skills to turn skills on for that project.
          </Text>
        </View>
      </View>

      <View style={[styles.search, { backgroundColor: c.card, borderColor: c.border }]}>
        <Search size={14} color={c.mutedForeground} />
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

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.foreground }]}>Built-in</Text>
        <Text style={[styles.muted, { color: c.mutedForeground }]}>
          Read-only skills that ship with Codenaya. Duplicate one to change it.
        </Text>
        {builtins.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground }]}>No built-in skills match "{search.trim()}".</Text>
        ) : (
          builtins.map((skill) => {
            const attribution = BUILTIN_SKILL_ATTRIBUTIONS[skill.name];
            return (
              <SkillCard
                key={skill.name}
                name={skill.name}
                description={skill.description}
                meta={attribution && `Adapted from ${attribution.label} · ${attribution.license} license`}
                c={c}
                actions={
                  <>
                    <Action label="View" icon={<Eye size={14} color={c.foreground} />} onPress={() => openEditor({ builtin: skill.name })} c={c} />
                    <Action label="Duplicate" icon={<Copy size={14} color={c.foreground} />} onPress={() => openEditor({ from: skill.name })} c={c} />
                  </>
                }
              />
            );
          })
        )}
      </View>

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
        <Text style={[styles.title, { color: c.foreground }]}>Your library</Text>
        {shown === undefined ? (
          <ActivityIndicator style={styles.loading} color={c.mutedForeground} />
        ) : library?.length === 0 ? (
          <View style={[styles.emptyBox, { borderColor: c.border }]}>
            <Sparkles size={20} color={c.mutedForeground} />
            <Text style={[styles.title, { color: c.foreground }]}>No skills in your library yet</Text>
            <Text style={[styles.muted, styles.center, { color: c.mutedForeground }]}>
              Write a skill once and enable it in any project: conventions, recipes or checklists the agent should
              follow.
            </Text>
            <View style={styles.actions}>
              <Button label="Import" variant="outline" icon={<Download size={15} color={c.foreground} />} onPress={() => setImportOpen(true)} />
              <Button label="New skill" icon={<Plus size={15} color={c.primaryForeground} />} onPress={() => openEditor()} />
            </View>
          </View>
        ) : shown.length === 0 ? (
          <Text style={[styles.empty, { color: c.mutedForeground }]}>No skills match "{search.trim()}".</Text>
        ) : (
          shown.map((skill) => (
            <SkillCard
              key={skill._id}
              name={skill.name}
              description={skill.description}
              meta={projectCountLabel(skill.projectCount)}
              c={c}
              actions={
                <>
                  <Action label="Edit" icon={<Pencil size={14} color={c.foreground} />} onPress={() => openEditor({ skillId: skill._id })} c={c} />
                  <Pressable onPress={() => confirmDelete(skill)} hitSlop={10} accessibilityLabel={`Delete ${skill.name}`} style={styles.delete}>
                    <Trash2 size={16} color={c.mutedForeground} />
                  </Pressable>
                </>
              }
            />
          ))
        )}
      </View>

      <Sheet visible={menuOpen} title="Add a skill" onClose={() => setMenuOpen(false)}>
        <SheetRow
          label="New skill"
          detail="Write the instructions yourself"
          trailing={<Plus size={16} color={c.mutedForeground} />}
          onPress={() => {
            setMenuOpen(false);
            openEditor();
          }}
        />
        <SheetRow
          label="Import"
          detail="From GitHub or skills.sh"
          trailing={<Download size={16} color={c.mutedForeground} />}
          onPress={() => {
            setMenuOpen(false);
            setImportOpen(true);
          }}
        />
      </Sheet>
      <ImportSkillSheet visible={importOpen} onClose={() => setImportOpen(false)} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { padding: 16, gap: 14, paddingBottom: 48 },
  card: { borderWidth: 1, borderRadius: radius.xl, padding: 14, gap: 10 },
  notice: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  title: { fontSize: 15, fontFamily: font.semibold },
  muted: { fontSize: 13, lineHeight: 18, fontFamily: font.regular },
  meta: { fontSize: 12, fontFamily: font.regular },
  center: { textAlign: "center" },
  empty: { textAlign: "center", paddingVertical: 12, fontSize: 13, fontFamily: font.regular },
  emptyBox: { alignItems: "center", gap: 8, borderWidth: 1, borderStyle: "dashed", borderRadius: radius.lg, padding: 18 },
  loading: { paddingVertical: 16 },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 40,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 12,
  },
  searchInput: { flex: 1, fontSize: 14, fontFamily: font.regular, paddingVertical: 0 },
  skill: { borderWidth: 1, borderRadius: radius.lg, padding: 12, gap: 4 },
  name: { fontSize: 14, fontFamily: "monospace" },
  actions: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 6 },
  action: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  actionText: { fontSize: 13, fontFamily: font.medium },
  delete: { marginLeft: "auto" },
  form: { gap: 12, padding: 12 },
  preview: { maxHeight: 220, borderWidth: 1, borderRadius: radius.md, padding: 10 },
  code: { fontFamily: "monospace", fontSize: 12, lineHeight: 18 },
});
