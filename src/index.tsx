import { promises as fs } from "fs";
import {
  Icon,
  Form,
  Action,
  ActionPanel,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
  Toast,
} from "@raycast/api";
import { useState } from "react";
import fetch from "node-fetch";
import * as cheerio from "cheerio";
import { GoogleGenAI } from "@google/genai";

interface Preferences {
  vault: string;
  aiPrompt: string;
  googleApiKey: string;    
  modelId: string;         
}

interface FormValues {
  urlField: string;
  titleField?: string;
  folderField: string;
  tagField?: string;
  commentField: string;
}

export default function Command() {
  const description = "Markdown is **supported**";
  const [extractContent, setExtractContent] = useState(false);
  const preferences = getPreferenceValues<Preferences>();
  const [urlError, setUrlError] = useState<string>();

  function dropUrlErrorIfNeeded() {
    if (urlError) setUrlError(undefined);
  }

  async function callGoogleGemini(prompt: string): Promise<string> {
    const ai = new GoogleGenAI({ apiKey: preferences.googleApiKey });
    const response = await ai.models.generateContent({
      model: preferences.modelId,
      contents: prompt,
    });
    return response.text ?? "";
  }

  async function onSubmit(values: FormValues) {
    if (!values.urlField) {
      await showToast({ style: Toast.Style.Failure, title: "Error", message: "Please provide a URL." });
      return;
    }

    try {
      // 1) Determine page title
      let pageTitle = values.titleField?.trim();
      if (!pageTitle) {
        const r = await fetch(values.urlField);
        const $ = cheerio.load(await r.text());
        pageTitle = $("title").first().text().trim() || "untitled";
      }

      // 2) Sanitize filename & build path
      const safeTitle = pageTitle.replace(/[<>:"/\\|?*]+/g, "").slice(0, 200);
      const folderPath = values.folderField
        ? `${preferences.vault}/${values.folderField}`
        : preferences.vault;

      // 3) Optional tags
      let tagsLine = "";
      if (values.tagField?.trim()) {
        tagsLine = `> **Tags:** ${values.tagField
          .split(",")
          .map((t) => `#${t.trim()}`)
          .join(" ")}`;
      }

      // 4) Fetch & extract all paragraphs
      const r2 = await fetch(values.urlField);
      const $2 = cheerio.load(await r2.text());
      const paragraphs: string[] = [];
      $2("p").each((_, p) => {
        const txt = $2(p).text().trim();
        if (txt) paragraphs.push(txt);
      });

      // Prepare snippet for AI
      const fullContent = paragraphs.join("\n\n");
      const words = fullContent.split(/\s+/);
      const MAX_WORDS = 700;
      const snippetWords = words.length > MAX_WORDS ? words.slice(0, MAX_WORDS) : words;
      const snippet = snippetWords.join(" ") + (words.length > MAX_WORDS ? " ..." : "");

      // 5) Generate summary (unless disabled)
      let summaryContent = "";
      if (!extractContent && snippet) {
        await showToast({ style: Toast.Style.Animated, title: "AI", message: "Summarizing content…" });
        try {
          let aiRaw = await callGoogleGemini(preferences.aiPrompt + snippet);
          aiRaw = aiRaw.replace(/^Here['’]s.*?\n/, "");      // strip preamble
          aiRaw = aiRaw.replace(/^\s*\*\s*/gm, "- ");        // normalize bullets
          summaryContent = aiRaw.trim();
        } catch (err) {
          console.error(err);
          await showToast({
            style: Toast.Style.Failure,
            title: "Gemini Error",
            message: (err as Error).message,
          });
          summaryContent = "⚠️ Failed to get summary.";
        }
      } else if (extractContent) {
        summaryContent = "AI Summary not enabled.";
      } else {
        summaryContent = "No content to summarize.";
      }

      // 6) Assemble Markdown
      const details = [
        `\n> [!info] Details`,
        `> **Title:** ${pageTitle}`,
        `> **URL:** ${values.urlField}`,
      ];
      if (tagsLine) details.push(tagsLine);

      const commentText = (values.commentField || "_no comments_").replace(/\r?\n+/g, " ").trim();

      // Header + summary
      const headerBlock = [
        details.join("\n"),
        `> [!documentation] Comments\n${commentText}`,
        `## AI Summary`,
        summaryContent,
      ].join("\n\n");

      // Only include Page Content if summary was actually generated
      let markdown = headerBlock;
      if (!extractContent) {
        const pageContentBlock = ["## Page Content", ...paragraphs].join("\n\n");
        markdown += `\n\n${pageContentBlock}`;
      }

      // 7) Write file
      await fs.mkdir(folderPath, { recursive: true });
      await fs.writeFile(`${folderPath}/${safeTitle}.md`, markdown);
      await showToast({ style: Toast.Style.Success, title: "Success", message: `Clipping "${pageTitle}" created.` });
    } catch (err) {
      console.error(err);
      await showToast({ style: Toast.Style.Failure, title: "Failure", message: "Couldn't create clipping." });
    }
  }

  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Create Clipping" onSubmit={onSubmit} icon={Icon.Bookmark} />
          <Action title="Open Extension Preferences" onAction={openExtensionPreferences} icon={Icon.Cog} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="urlField"
        title="URL"
        placeholder="Enter URL"
        error={urlError}
        onChange={dropUrlErrorIfNeeded}
        onBlur={async (e) => {
          const url = String(e.target.value);
          const valid = /^(https?):\/\/[^\s/$.?#].[^\s]*$/i.test(url);
          if (!url) setUrlError("Field is empty.");
          else if (!valid) setUrlError("Invalid URL");
          else if (!url.startsWith("https://")) setUrlError("Requires https://");
          else {
            try {
              const r = await fetch(url);
              if (r.ok) dropUrlErrorIfNeeded();
              else setUrlError("URL not reachable.");
            } catch {
              setUrlError("Failed to fetch URL.");
            }
          }
        }}
      />
      <Form.TextField id="titleField" title="Title (optional)" placeholder="Auto-fetch if blank" />
      <Form.TextField id="folderField" title="Sub-Folder" placeholder="Optional" info="Saved under vault root if empty" />
      <Form.TextField id="tagField" title="Tag(s) (optional)" placeholder="Comma-separated, leave blank for none" />
      <Form.TextArea id="commentField" title="Comment(s)" placeholder={description} enableMarkdown />
      <Form.Checkbox
        id="extractContent"
        label="Enable AI Summarization & Page Content"
        info="Check if you only want summary and page content."
        defaultValue={extractContent}
        onChange={() => setExtractContent(!extractContent)}
      />
    </Form>
  );
}
