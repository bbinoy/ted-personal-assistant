// The fake Notion of the end-to-end eval: the owner's claude.ai Notion connector under its real name, with the four tools the model is offered (notion-search, notion-fetch, notion-create-pages, notion-update-page) and the
// result shapes of the real ones (copied from tool results, never content). It holds databases (one data source each) and pages, and records what was created.
import { z } from "zod";
import { fakeService, type FakeService, type Recorder } from "./fakeserver.ts";

const NOTION_SERVER = "claude.ai Notion";

export interface SeedDatabase {
  id: string;
  title: string;
  dataSourceId: string;
  schema: Record<string, { type: "title" | "text" | "select" | "date" | "number"; options?: string[] }>;
}
export interface NotionPage {
  id: string;
  title: string;
  dataSourceId?: string; // the database it is a row of
  properties: Record<string, unknown>;
  content: string;
  createdByCall: boolean;
}

export class FakeNotion {
  databases: SeedDatabase[];
  pages: NotionPage[] = [];
  readonly service: FakeService;
  private next = 1;

  constructor(rec: Recorder, databases: SeedDatabase[] = []) {
    this.databases = databases;
    const dbText = (d: SeedDatabase) =>
      [
        `<database url="https://notion.example.com/${d.id}" inline="false">`,
        `The title of this Database is: ${d.title}`,
        `<data-source url="collection://${d.dataSourceId}">`,
        `The title of this Data Source is: ${d.title}`,
        "Here is the schema of this data source:",
        "<data-source-state>",
        JSON.stringify({ name: d.title, schema: Object.fromEntries(Object.entries(d.schema).map(([k, v]) => [k, { type: v.type, ...(v.options ? { options: v.options.map((name) => ({ name })) } : {}) }])) }),
        "</data-source-state>",
        "</data-source>",
        "</database>",
      ].join("\n");
    const find = (id: string) => this.databases.find((d) => d.id === id || d.dataSourceId === id.replace(/^collection:\/\//, ""));
    this.service = fakeService(NOTION_SERVER, rec, {
      "notion-search": {
        description: "Search the workspace by title or content.",
        shape: { query: z.string(), query_type: z.string().optional(), page_size: z.number().optional(), data_source_url: z.string().optional(), filters: z.unknown().optional() },
        run: (a) => {
          const q = String(a.query).toLowerCase();
          const words = q.split(/\s+/).filter(Boolean);
          const hit = (text: string) => words.some((w) => text.toLowerCase().includes(w));
          return {
            results: [
              ...this.databases.filter((d) => hit(d.title)).map((d) => ({ id: d.id, title: d.title, url: `https://notion.example.com/${d.id}`, type: "database", highlight: d.title, timestamp: new Date(0).toISOString() })),
              ...this.pages.filter((p) => hit(`${p.title} ${p.content}`)).map((p) => ({ id: p.id, title: p.title, url: `https://notion.example.com/${p.id}`, type: "page", highlight: p.title, timestamp: new Date(0).toISOString() })),
            ],
            type: "workspace_search",
          };
        },
      },
      "notion-fetch": {
        description: "Fetch a page or database by id or url.",
        shape: { id: z.string() },
        run: (a) => {
          const id = String(a.id).replace(/^https?:\/\/notion\.example\.com\//, "");
          const d = find(id);
          if (d) return { metadata: { type: "database" }, title: d.title, url: `https://notion.example.com/${d.id}`, text: dbText(d) };
          const p = this.pages.find((x) => x.id === id);
          if (!p) throw new Error(`Could not find page or database with ID: ${id}`);
          return { metadata: { type: "page" }, title: p.title, url: `https://notion.example.com/${p.id}`, text: `${JSON.stringify(p.properties)}\n${p.content}`, page_last_edited_at: new Date(0).toISOString() };
        },
      },
      "notion-create-pages": {
        description: "Create pages, as rows of a data source (parent.data_source_id) or standalone.",
        shape: { parent: z.object({ type: z.string().optional(), data_source_id: z.string().optional(), database_id: z.string().optional(), page_id: z.string().optional() }).passthrough().optional(), pages: z.array(z.object({ properties: z.record(z.string(), z.unknown()).optional(), content: z.string().optional() }).passthrough()) },
        run: (a) => {
          const dsId = a.parent?.data_source_id ?? a.parent?.database_id;
          const db = dsId ? find(dsId) : undefined;
          if (dsId && !db) throw new Error(`Could not find data source ${dsId}`);
          const made = (a.pages as { properties?: Record<string, unknown>; content?: string }[]).map((p) => {
            const props = p.properties ?? {};
            const title = String(props.title ?? props.Name ?? props[Object.entries(db?.schema ?? {}).find(([, v]) => v.type === "title")?.[0] ?? "title"] ?? "Untitled");
            const page: NotionPage = { id: `page${String(this.next++).padStart(4, "0")}`, title, dataSourceId: db?.dataSourceId, properties: props, content: p.content ?? "", createdByCall: true };
            this.pages.push(page);
            return { id: page.id, url: `https://notion.example.com/${page.id}`, properties: props };
          });
          return { pages: made };
        },
      },
      "notion-update-page": {
        description: "Change a page's properties or content.",
        shape: { page_id: z.string(), command: z.string().optional(), properties: z.record(z.string(), z.unknown()).optional(), content_updates: z.array(z.object({ old_str: z.string(), new_str: z.string() })).optional(), new_str: z.string().optional(), in_trash: z.boolean().optional(), archived: z.boolean().optional() },
        run: (a) => {
          const p = this.pages.find((x) => x.id === a.page_id);
          if (!p) throw new Error(`Could not find page with ID: ${a.page_id}`);
          Object.assign(p.properties, a.properties ?? {});
          for (const u of a.content_updates ?? []) p.content = p.content.replace(u.old_str, u.new_str);
          return { page_id: p.id };
        },
      },
    });
  }

  final(): NotionPage[] {
    return this.pages.map((p) => ({ ...p }));
  }
}
