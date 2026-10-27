import { useAuth } from "@clerk/expo";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

import type { Doc } from "../../../convex/_generated/dataModel";
import { Button, Field, Segmented } from "@/components/form";
import { CheckCircle2, ExternalLink, Lock, Globe, XCircle } from "@/components/icons";
import { Sheet } from "@/components/sheet";
import { GITHUB_NOT_LINKED, alertGithubNotLinked } from "@/lib/github";
import { postApi } from "@/lib/http";
import { font, useColors } from "@/lib/theme";

/** Tailwind's emerald-500, the web's success tint. */
const SUCCESS = "#10b981";
const REPO_NAME = /^[a-zA-Z0-9._-]+$/;

/** The web form's rules (export-popover.tsx); the route checks them again. */
const validate = (repoName: string, description: string) => {
  if (!repoName) return "Repository name is required";
  if (repoName.length > 100) return "Repository name is too long";
  if (!REPO_NAME.test(repoName)) return "Only alphanumeric characters, hyphens, underscores, and dots are allowed";
  if (description.length > 350) return "Description is too long";
};

/**
 * The web's Export to GitHub popover as a sheet: a form to create the repo,
 * then the export job's progress from the project's exportStatus.
 */
export function GithubExportSheet({
  project,
  visible,
  onClose,
}: {
  project: Doc<"projects">;
  visible: boolean;
  onClose: () => void;
}) {
  const c = useColors();
  const { getToken } = useAuth();
  const [repoName, setRepoName] = useState(project.name.replace(/[^a-zA-Z0-9._-]/g, "-"));
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const projectId = project._id;

  const post = (path: string, body: object) => postApi(path, body, getToken);

  const create = async () => {
    const problem = validate(repoName.trim(), description);
    if (problem) return setError(problem);
    setBusy(true);
    setError(undefined);
    try {
      const { ok, data } = await post("/api/github/export", {
        projectId,
        repoName: repoName.trim(),
        visibility,
        description: description || undefined,
      });
      if (data.code === GITHUB_NOT_LINKED) {
        onClose();
        alertGithubNotLinked();
      } else if (!ok) {
        setError(data.error ?? "Unable to export repository");
      }
    } catch {
      setError("Couldn't reach Codenaya. Is the server running?");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => post("/api/github/export/cancel", { projectId }).catch(() => undefined);
  const reset = () => post("/api/github/export/reset", { projectId }).catch(() => undefined);

  const status = project.exportStatus;
  let content;
  if (status === "exporting") {
    content = (
      <View style={styles.state}>
        <ActivityIndicator color={c.mutedForeground} />
        <Text style={[styles.muted, { color: c.mutedForeground }]}>Exporting to GitHub...</Text>
        <Button label="Cancel" variant="outline" onPress={cancel} />
      </View>
    );
  } else if (status === "completed" && project.exportRepoUrl) {
    const url = project.exportRepoUrl;
    content = (
      <View style={styles.state}>
        <CheckCircle2 size={24} color={SUCCESS} />
        <Text style={[styles.heading, { color: c.foreground }]}>Repository created</Text>
        <Text style={[styles.muted, { color: c.mutedForeground }]}>Your project has been exported to GitHub.</Text>
        <Button
          label="View on GitHub"
          icon={<ExternalLink size={15} color={c.primaryForeground} />}
          onPress={() => WebBrowser.openBrowserAsync(url)}
        />
        <Button
          label="Close"
          variant="outline"
          onPress={async () => {
            await reset();
            onClose();
          }}
        />
      </View>
    );
  } else if (status === "failed") {
    content = (
      <View style={styles.state}>
        <XCircle size={24} color={c.destructive} />
        <Text style={[styles.heading, { color: c.foreground }]}>Unable to export</Text>
        <Text style={[styles.muted, { color: c.mutedForeground }]}>Something went wrong. Please try again.</Text>
        <Button label="Retry" variant="outline" onPress={reset} />
      </View>
    );
  } else {
    content = (
      <View style={styles.form}>
        <Field label="Repository name" value={repoName} onChangeText={setRepoName} placeholder="my-project" />
        <Segmented
          label="Visibility"
          value={visibility}
          onChange={setVisibility}
          options={[
            { value: "private", label: "Private", icon: <Lock size={13} color={c.mutedForeground} /> },
            { value: "public", label: "Public", icon: <Globe size={13} color={c.mutedForeground} /> },
          ]}
        />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="A short description of your project"
          autoCapitalize="sentences"
          autoCorrect
          multiline
        />
        {error && <Text style={[styles.error, { color: c.destructive }]}>{error}</Text>}
        <Button label={busy ? "Creating..." : "Create repository"} busy={busy} onPress={create} />
      </View>
    );
  }

  return (
    <Sheet
      visible={visible}
      title="Export to GitHub"
      description="Export your project to a GitHub repository."
      onClose={onClose}
    >
      {content}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 14, padding: 12 },
  state: { alignItems: "stretch", gap: 10, padding: 12 },
  heading: { fontSize: 15, fontFamily: font.medium, textAlign: "center" },
  muted: { fontSize: 13, fontFamily: font.regular, textAlign: "center" },
  error: { fontSize: 13, fontFamily: font.regular },
});
