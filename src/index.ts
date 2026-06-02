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

async function getDownloadInfo(
	slug: string,
	version: string,
	loader: string,
): Promise<{ url: string; filename: string; dependencies: Array<{ project_id: string; dependency_type: string }> } | null> {
	const params = new URLSearchParams({
		loaders: JSON.stringify([loader]),
		game_versions: JSON.stringify([version]),
		version_type: "release",
	});

	const res = await fetch(`${API_BASE}/project/${slug}/version?${params}`, {
		headers: { "User-Agent": USER_AGENT },
	});

	if (!res.ok) return null;

	const data = (await res.json()) as Array<{
		files: Array<{ primary: boolean; url: string; filename: string }>;
		dependencies: Array<{ project_id: string; dependency_type: string }>;
	}>;

	if (!data.length) return null;

	const file = data[0].files.find((f) => f.primary) ?? data[0].files[0] ?? null;
	if (!file) return null;

	return {
		url: file.url,
		filename: file.filename,
		dependencies: data[0].dependencies ?? [],
	};
}

async function resolveMod(
	slug: string,
	version: string,
	loader: string,
	files: Record<string, Uint8Array>,
	resolved: Set<string>,
): Promise<void> {
	if (resolved.has(slug)) return;
	resolved.add(slug);

	const info = await getDownloadInfo(slug, version, loader);
	if (!info) {
		console.warn(`No compatible version found for ${slug}`);
		return;
	}

	const fileRes = await fetch(info.url);
	if (!fileRes.ok) {
		console.warn(`Failed to fetch ${slug}: ${fileRes.status}`);
		return;
	}

	files[info.filename] = new Uint8Array(await fileRes.arrayBuffer());
	console.log(`Packed ${info.filename}`);

	// Resolve required dependencies recursively
	const requiredDeps = info.dependencies.filter((d) => d.dependency_type === "required");

	await Promise.allSettled(requiredDeps.map((dep) => resolveMod(dep.project_id, version, loader, files, resolved)));
}

app.post("/download", async (req: Request, res: Response) => {
	const { mods, version, loader } = req.body as DownloadRequest;

	if (!mods?.length || !version || !loader) {
		res.status(400).json({ error: "Missing mods, version, or loader" });
		return;
	}

	const files: Record<string, Uint8Array> = {};
	const resolved = new Set<string>(); // tracks slugs/ids already fetched

	await Promise.allSettled(mods.map((mod) => resolveMod(mod.slug, version, loader, files, resolved)));

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

app.listen(3000, () => {
	console.log("Server running on http://localhost:3000");
});
