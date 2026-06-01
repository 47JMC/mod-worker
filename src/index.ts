import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import express, { Request, Response } from "express";
import cors from "cors";
import { zipSync } from "fflate";

const API_BASE = "https://api.modrinth.com/v2";
const USER_AGENT = "ModDownloader/1.0";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
	res.send("Hello, World!");
});

interface Mod {
	slug: string;
	title: string;
}

interface ModVersion {
	files: Array<{ primary: boolean; url: string; filename: string }>;
}

interface DownloadRequest {
	mods: Mod[];
	version: string;
	loader: string;
}

async function getDownloadInfo(slug: string, version: string, loader: string): Promise<{ url: string; filename: string } | null> {
	const params = new URLSearchParams({
		loaders: JSON.stringify([loader]),
		game_versions: JSON.stringify([version]),
		version_type: "release",
	});

	const res = await fetch(`${API_BASE}/project/${slug}/version?${params}`, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!res.ok) return null;

	const data = (await res.json()) as ModVersion[];
	if (!data.length) return null;

	const file = data[0].files.find((f) => f.primary) ?? data[0].files[0] ?? null;
	if (!file) return null;

	return { url: file.url, filename: file.filename, data: data };
}

app.post("/download", async (req: Request<{}, {}, DownloadRequest>, res: Response) => {
	const { mods, version, loader } = req.body;

	if (!mods?.length || !version || !loader) {
		res.status(400).json({ error: "Missing mods, version, or loader" });
		return;
	}

	const files: Record<string, Uint8Array> = {};

	const results = await Promise.allSettled(
		mods.map(async (mod) => {
			const info = await getDownloadInfo(mod.slug, version, loader);
			if (!info) {
				console.warn(`No compatible version found for ${mod.slug}`);
				return;
			}

			const fileRes = await fetch(info.url);
			if (!fileRes.ok) {
				console.warn(`Failed to fetch ${mod.slug}: ${fileRes.status}`);
				return;
			}

			files[info.filename] = new Uint8Array(await fileRes.arrayBuffer());
			console.log(`Packed ${info.filename}`);
		}),
	);

	const failed = results.map((r, i) => (r.status === "rejected" ? mods[i].slug : null)).filter(Boolean);

	if (failed.length) console.warn("Failed:", failed);

	if (Object.keys(files).length === 0) {
		res.status(404).json({ error: "No compatible mods found" });
		return;
	}

	const zipped = zipSync(files);

	res.set({
		"Content-Type": "application/zip",
		"Content-Disposition": "attachment; filename=mods.zip",
	});
	res.send(Buffer.from(zipped));
});

app.listen(3000);
export default httpServerHandler(3000);
