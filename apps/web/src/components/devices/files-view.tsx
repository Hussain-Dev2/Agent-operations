"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Download, File, Folder, FolderOpen, House, Link2, Loader2, RefreshCw, Upload } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { toast } from "sonner";
import type { Device, FileEntry } from "@operator/shared";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useErrorMessage } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { callTool } from "@/lib/tools";

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : `${dir}${sep}${name}`;
}

function crumbs(path: string): { label: string; path: string }[] {
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const parts = path.split(sep).filter(Boolean);
  const root = sep === "/" ? "/" : "";
  return parts.map((label, i) => ({ label, path: root + parts.slice(0, i + 1).join(sep) + (sep === "\\" && i === 0 ? "\\" : "") }));
}

const ICONS: Record<FileEntry["kind"], typeof File> = { dir: Folder, file: File, link: Link2, other: File };

/** Request size stays well under proxy body limits (Next.js rewrites cap at ~10 MB). */
const PART_BYTES = 4 * 1024 * 1024;

/** One part via XHR (fetch has no upload progress). */
function uploadPart(deviceId: string, path: string, offset: number, part: Blob, onProgress: (loaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/devices/${deviceId}/files/upload?path=${encodeURIComponent(path)}&offset=${offset}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      onProgress(e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => {
      reject(new Error("Upload failed"));
    };
    xhr.send(part);
  });
}

/** Upload a file as sequential parts written at increasing offsets. */
async function upload(deviceId: string, path: string, file: Blob, onProgress: (fraction: number) => void): Promise<void> {
  const total = Math.max(1, file.size);
  let offset = 0;
  do {
    const part = file.slice(offset, offset + PART_BYTES);
    const base = offset;
    await uploadPart(deviceId, path, base, part, (loaded) => {
      onProgress((base + loaded) / total);
    });
    offset += part.size;
  } while (offset < file.size);
  onProgress(1);
}

export function FilesView({ device }: { device: Device }) {
  const t = useTranslations("device.files");
  const locale = useLocale();
  const format = useFormatter();
  const errorMessage = useErrorMessage();
  const [path, setPath] = useState<string | undefined>(undefined);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const canWrite = device.permissionLevel !== "view_only" && !device.killed;

  const listing = useQuery({
    queryKey: ["files", device.id, path ?? "~"],
    queryFn: () => callTool(device.id, "file_list", path === undefined ? {} : { path }),
    enabled: device.online,
  });
  const current = listing.data?.path;

  const onFiles = async (files: FileList | null): Promise<void> => {
    if (!files || !current) return;
    for (const file of Array.from(files)) {
      setProgress({ name: file.name, fraction: 0 });
      try {
        await upload(device.id, join(current, file.name), file, (fraction) => {
          setProgress({ name: file.name, fraction });
        });
        toast.success(t("uploaded", { name: file.name }));
      } catch (error) {
        toast.error(errorMessage(error));
      }
    }
    setProgress(null);
    void listing.refetch();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => { setPath(undefined); }} aria-label={t("home")}>
          <House />
        </Button>
        <Button size="sm" variant="outline" disabled={!listing.data?.parent} onClick={() => { setPath(listing.data?.parent ?? undefined); }} aria-label={t("up")}>
          <ArrowUp />
        </Button>
        <nav dir="ltr" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto font-mono text-xs text-muted-foreground">
          {current &&
            crumbs(current).map((c) => (
              <button key={c.path} type="button" className="shrink-0 rounded px-1 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => { setPath(c.path); }}>
                /{c.label}
              </button>
            ))}
        </nav>
        <Button size="sm" variant="ghost" onClick={() => void listing.refetch()} aria-label={t("refresh")}>
          <RefreshCw className={listing.isFetching ? "animate-spin" : undefined} />
        </Button>
        {canWrite && (
          <>
            <Button size="sm" onClick={() => input.current?.click()} disabled={progress !== null || !current}>
              <Upload />
              {t("upload")}
            </Button>
            <input ref={input} type="file" multiple hidden onChange={(e) => void onFiles(e.target.files).finally(() => { e.target.value = ""; })} />
          </>
        )}
      </div>

      {progress && (
        <div className="grid gap-1.5 rounded-lg border p-3 text-sm">
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" />
            {t("uploading", { name: progress.name })}
          </span>
          <Progress value={progress.fraction * 100} />
        </div>
      )}

      {listing.isPending ? (
        <div className="grid gap-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 rounded-lg" />
          ))}
        </div>
      ) : listing.isError ? (
        <EmptyState icon={FolderOpen} title={errorMessage(listing.error)} body="" />
      ) : listing.data.entries.length === 0 ? (
        <EmptyState icon={FolderOpen} title={t("empty")} body="" />
      ) : (
        <div className="overflow-hidden rounded-xl border">
          <ul className="divide-y">
            {listing.data.entries.map((entry) => {
              const Icon = ICONS[entry.kind];
              const full = join(listing.data.path, entry.name);
              return (
                <li key={entry.name} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                  <Icon className={entry.kind === "dir" ? "size-4 shrink-0 text-primary" : "size-4 shrink-0 text-muted-foreground"} />
                  {entry.kind === "dir" ? (
                    <button type="button" dir="auto" className="min-w-0 flex-1 truncate text-start font-medium" onClick={() => { setPath(full); }}>
                      {entry.name}
                    </button>
                  ) : (
                    <span dir="auto" className="min-w-0 flex-1 truncate">
                      {entry.name}
                    </span>
                  )}
                  <span className="hidden w-24 shrink-0 text-end text-xs tabular-nums text-muted-foreground sm:block">
                    {entry.kind === "file" ? formatBytes(entry.size, locale) : ""}
                  </span>
                  <span className="hidden w-32 shrink-0 text-end text-xs text-muted-foreground md:block">
                    {entry.mtime ? format.dateTime(new Date(entry.mtime), { dateStyle: "medium" }) : ""}
                  </span>
                  {entry.kind === "file" ? (
                    <Button asChild variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("download")}>
                      <a href={`/api/devices/${device.id}/files/download?path=${encodeURIComponent(full)}`} download={entry.name}>
                        <Download />
                      </a>
                    </Button>
                  ) : (
                    <span className="size-8 shrink-0" />
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
