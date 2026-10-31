import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { main } from '@kensho/cli';
import type { AssetGateReport } from '@kensho/gates-asset';
import { OUT_DIR, ROOT } from './paths.ts';

/** Provenance and declared properties for a set of real assets. File paths are relative to the source folder. */
export interface RealManifest {
  format: 'kensho-real-assets/1';
  source: string;
  note: string;
  assets: {
    id: string;
    class: 'hero' | 'prop' | 'background';
    body: 'dynamic' | 'static';
    box_um: [number, number, number] | null;
    size_largest_um: number;
    anchored: boolean;
    raw: { file: string; sha256: string; bytes: number; job: { prompt: string; tier: string; generation_id: string; submitted_at: string; generation_seconds: number }; bang_job?: { kind: string; generation_id: string } };
    split: { file: string; sha256: string; bytes: number };
  }[];
}

type SetName = 'raw' | 'split';
const TIERS = ['mobile', 'desktop'] as const;

/** The JSON chunk of a GLB, read without loading the binary chunk. */
export function readGlbJson(path: string): { asset?: { generator?: string; version?: string }; extensionsUsed?: string[]; extensionsRequired?: string[]; nodes?: { name?: string }[]; meshes?: { name?: string; primitives: unknown[] }[]; materials?: unknown[]; images?: { mimeType?: string }[]; extras?: unknown; scenes?: unknown[] } {
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(20);
    readSync(fd, head, 0, 20, 0);
    const len = head.readUInt32LE(12);
    const body = Buffer.alloc(len);
    readSync(fd, body, 0, len, 20);
    return JSON.parse(body.toString('utf8'));
  } finally {
    closeSync(fd);
  }
}

const sha256File = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex');

async function gate(file: string, tier: string, cls: string, body: string): Promise<{ exit: number; report: AssetGateReport }> {
  let stdout = '';
  let stderr = '';
  const exit = await main(['asset-gate', file, '--tier', tier, '--class', cls, '--body', body, '--timeout-ms', '300000'], { stdout: (t) => void (stdout += t), stderr: (t) => void (stderr += t) });
  if (!stdout) throw new Error(`asset-gate printed nothing for ${file}: ${stderr}`);
  return { exit, report: JSON.parse(stdout) as AssetGateReport };
}

const fmtM = (um: number | undefined) => (um === undefined ? '-' : (um / 1e6).toFixed(3));
const codes = (r: AssetGateReport, sev: string) => [...new Set(r.diagnostics.filter((d) => d.severity === sev).map((d) => d.code))].join(', ') || '-';

async function run(): Promise<number> {
  const args = process.argv.slice(2);
  const srcDir = args.find((a) => !a.startsWith('--'));
  const manifestPath = resolve(ROOT, args.includes('--manifest') ? args[args.indexOf('--manifest') + 1]! : 'corpus/assets/real/golem.manifest.json');
  if (!srcDir) {
    console.error('usage: pnpm real-assets <source-dir> [--manifest path]');
    return 3;
  }
  const src = resolve(srcDir);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RealManifest;
  const outDir = join(OUT_DIR, 'real');
  mkdirSync(outDir, { recursive: true });
  const problems: string[] = [];
  const rows: { set: SetName; id: string; tier: string; class: string; body: string; exit: number; report: AssetGateReport; scalePpm: number | null }[] = [];
  const provenance: Record<string, unknown>[] = [];

  for (const a of manifest.assets) {
    // linkage: the sidecar the file came with must agree with the manifest
    const jobFile = join(src, 'assets', 'raw', `${a.id}.job.json`);
    const job = existsSync(jobFile) ? (JSON.parse(readFileSync(jobFile, 'utf8')) as { generation_id?: string; prompt?: string }) : null;
    const linked = job?.generation_id === a.raw.job.generation_id && job?.prompt === a.raw.job.prompt;
    if (!linked) problems.push(`${a.id}: the job sidecar does not match the manifest`);
    const glbRaw = join(src, a.raw.file);
    const glbSplit = join(src, a.split.file);
    const meta: Record<string, unknown> = { id: a.id, generation_id: a.raw.job.generation_id, job_sidecar_linked: linked };
    for (const [set, entry, file] of [['raw', a.raw, glbRaw], ['split', a.split, glbSplit]] as const) {
      if (!existsSync(file)) {
        problems.push(`${a.id}/${set}: ${entry.file} is missing`);
        continue;
      }
      const sha = sha256File(file);
      if (sha !== entry.sha256) {
        problems.push(`${a.id}/${set}: SHA-256 differs from the frozen manifest (${sha.slice(0, 12)} vs ${entry.sha256.slice(0, 12)}); skipped`);
        continue;
      }
      const j = readGlbJson(file);
      meta[set] = { sha256: sha, bytes: entry.bytes, generator: j.asset?.generator ?? null, extensions_used: j.extensionsUsed ?? [], extensions_required: j.extensionsRequired ?? [], nodes: j.nodes?.length ?? 0, meshes: j.meshes?.length ?? 0, primitives: (j.meshes ?? []).reduce((n, m) => n + m.primitives.length, 0), materials: j.materials?.length ?? 0, images: (j.images ?? []).map((i) => i.mimeType ?? '?'), node_names_sample: (j.nodes ?? []).slice(0, 12).map((n) => n.name ?? ''), extras_present: j.extras !== undefined };
      for (const tier of TIERS) {
        const { exit, report } = await gate(file, tier, a.class, a.body);
        writeFileSync(join(outDir, `${set}-${a.id}@${tier}.json`), JSON.stringify(report, null, 2) + '\n');
        const dims = report.measures.bbox_um as number[] | undefined;
        const largest = dims ? Math.max(...dims) : 0;
        rows.push({ set, id: a.id, tier, class: a.class, body: a.body, exit, report, scalePpm: largest ? Math.round((a.size_largest_um / largest) * 1e6) : null });
        console.error(`[real] ${set}/${a.id}@${tier}: ${report.verdict} ${[...new Set(report.diagnostics.map((d) => d.code))].join(',')}`);
      }
    }
    provenance.push(meta);
  }

  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ source: manifest.source, manifest: manifestPath.replace(ROOT, '.'), problems, provenance, runs: rows.map((r) => ({ set: r.set, id: r.id, tier: r.tier, class: r.class, body: r.body, exit: r.exit, verdict: r.report.verdict, verdict_hash: r.report.verdict_hash, diagnostics: r.report.diagnostics, measures: r.report.measures, checks: r.report.checks, scale_to_declared_largest_ppm: r.scalePpm, ms: r.report.timings_ms.total })) }, null, 2) + '\n');

  const md: string[] = ['# Real assets: GOLEM props through `kensho asset-gate`', '', 'Generated by `pnpm real-assets`. Raw files are the unmodified Rodin outputs; split files are GOLEM\'s articulated outputs built from them. Class and body are assignments (see the manifest); `box_um` is null for every asset because only the largest real-world dimension was ever declared, so the box-conformance check is `not_checked`, never passed.', ''];
  if (problems.length) md.push('## Problems', '', ...problems.map((p) => `- ${p}`), '');
  for (const set of ['raw', 'split'] as const) {
    md.push(`## ${set === 'raw' ? 'Raw Rodin outputs' : 'GOLEM split outputs'}`, '', '| Asset | Class / body | Tier | Verdict | Errors | Warnings | Triangles | Prims | Mats | Max tex px | GPU MB | Islands (floating) | Boundary / non-manifold edges | Collider | World size (m) |', '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---|---|---|---|');
    for (const r of rows.filter((x) => x.set === set)) {
      const m = r.report.measures as Record<string, number | number[] | Record<string, number | string>>;
      const c = m.collider as Record<string, number | string> | undefined;
      const collider = c ? `${c.kind}${c.hull_vertices !== undefined ? ` (${c.hull_vertices}/${c.hull_vertices_full} v)` : ''}` : '-';
      md.push(`| ${r.id} | ${r.class} / ${r.body} | ${r.tier} | **${r.report.verdict}** | ${codes(r.report, 'error')} | ${codes(r.report, 'warning')} | ${m.triangles} | ${m.primitives} | ${m.materials} | ${m.texture_max_dim} | ${((m.texture_gpu_bytes as number) / 1048576).toFixed(1)} | ${m.islands} (${m.floating_islands}) | ${m.boundary_edges} / ${m.nonmanifold_edges} | ${collider} | ${(m.bbox_um as number[] | undefined)?.map((v) => fmtM(v)).join(' × ') ?? '-'} |`);
    }
    md.push('');
  }
  md.push('## Scale to the declared largest dimension', '', 'Raw Rodin meshes arrive normalised to about two units. The multiplier that would bring each raw asset to its declared largest real-world dimension:', '', '| Asset | Declared largest (m) | Measured largest (m) | Multiplier |', '|---|---:|---:|---:|');
  for (const a of manifest.assets) {
    const r = rows.find((x) => x.set === 'raw' && x.id === a.id && x.tier === 'mobile');
    const dims = r?.report.measures.bbox_um as number[] | undefined;
    md.push(`| ${a.id} | ${fmtM(a.size_largest_um)} | ${dims ? fmtM(Math.max(...dims)) : '-'} | ${r?.scalePpm ? (r.scalePpm / 1e6).toFixed(4) : '-'} |`);
  }
  md.push('', '## Every diagnostic', '');
  for (const r of rows) {
    if (!r.report.diagnostics.length) continue;
    md.push(`- **${r.set}/${r.id}@${r.tier}**`);
    for (const d of r.report.diagnostics) md.push(`  - ${d.severity} \`${d.code}\` at \`${d.pointer || '(root)'}\`: ${d.message}`);
  }
  md.push('', '## Not checked or abstained', '');
  for (const r of rows) {
    const nc = Object.entries(r.report.checks).filter(([, c]) => c.status !== 'ran');
    if (nc.length) md.push(`- ${r.set}/${r.id}@${r.tier}: ${nc.map(([k, c]) => `${k} ${c.status}${c.reason ? ` (${c.reason})` : ''}`).join('; ')}`);
  }
  md.push('');
  writeFileSync(join(outDir, 'REAL_ASSETS.md'), md.join('\n'));
  console.error(`[real] wrote bench/out/real/ (${rows.length} runs, ${problems.length} problem(s))`);
  return problems.length ? 1 : 0;
}

process.exitCode = await run().catch((e) => {
  console.error('[real] crashed:', e);
  return 2;
});
