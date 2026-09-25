"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useStudio } from "@/stores/use-studio";
import { useToasts } from "@/stores/use-ui";
import { projectNameSchema } from "@/lib/schemas";
import { SlateButton, SlateIconButton } from "@/components/slate/button";
import { SlateDropdown, SlateOption } from "@/components/slate/dropdown";
import { SlateField, SlateLabel } from "@/components/slate/core";
import { SlateModal, SlateModalHead } from "@/components/slate/overlays";
import { pendingOf } from "@/lib/pricing";

export function ProjectList({ compact }: { compact?: boolean }) {
  const projects = useStudio((s) => s.projects);
  const activeId = useStudio((s) => s.activeId);
  const params = useParams<{ tab?: string }>();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  // Project switch must navigate (route is the source of truth for the
  // active project) — the tab page then syncs the store from the URL.
  const pick = (id: string) => {
    if (id === activeId) return;
    router.push(`/p/${id}/${params.tab ?? "generate"}`);
  };

  return (
    <>
      <div className="rounded-[12px] border slate-hair overflow-hidden bg-surface">
        {projects.map((q, i) => (
          <div
            key={q.id}
            onClick={() => pick(q.id)}
            role="option"
            aria-selected={q.id === activeId}
            className={`flex items-center gap-2.5 pl-2.5 pr-1.5 py-2 cursor-pointer ${
              i > 0 ? "border-t slate-hair" : ""
            } ${q.id === activeId ? "bg-[var(--t-brand-bg)]" : "hover:bg-surface2"}`}
          >
            <span
              className={`w-2.5 h-2.5 rounded-full shrink-0 ${pendingOf(q) > 0 ? "animate-pulse" : ""}`}
              style={{ background: pendingOf(q) > 0 ? "#B8790E" : "var(--muted)" }}
              title={pendingOf(q) > 0 ? `${pendingOf(q)} running` : q.name}
            />
            <span className="flex-1 min-w-0 truncate text-[13px] font-semibold leading-tight">{q.name}</span>
            <SlateDropdown
              trigger={
                <SlateIconButton
                  variant="quiet"
                  size="icon-xs"
                  label="Project options"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="size-3.5" />
                </SlateIconButton>
              }
              label=""
              menu={(close) => (
                <>
                  <SlateOption
                    onPick={() => setRenaming({ id: q.id, name: q.name })}
                    onClose={close}
                  >
                    <span className="flex items-center gap-2">
                      <Pencil className="size-3.5 text-fg2" /> Rename
                    </span>
                  </SlateOption>
                  <SlateOption
                    tone="danger"
                    onPick={() => setDeleting({ id: q.id, name: q.name })}
                    onClose={close}
                  >
                    <span className="flex items-center gap-2">
                      <Trash2 className="size-3.5" /> Delete
                    </span>
                  </SlateOption>
                </>
              )}
            />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setCreating(true)}
        className="mt-2 w-full h-9 rounded-[10px] border border-dashed slate-hair text-[12.5px] font-bold text-fg2 hover:border-[#3FA96D] flex items-center justify-center gap-1.5"
      >
        <Plus className="size-3.5" /> New project
      </button>
      {creating && <ProjectModal done={() => setCreating(false)} />}
      {renaming && <ProjectModal initial={renaming} done={() => setRenaming(null)} />}
      {deleting && <DeleteProjectConfirm id={deleting.id} name={deleting.name} done={() => setDeleting(null)} />}
      {compact ? null : null}
    </>
  );
}

function ProjectModal({ initial, done }: { initial?: { id: string; name: string }; done: () => void }) {
  const [v, setV] = useState(initial?.name ?? "");
  const [err, setErr] = useState("");
  const createProject = useStudio((s) => s.createProject);
  const renameProject = useStudio((s) => s.renameProject);
  const push = useToasts((s) => s.push);
  const router = useRouter();

  return (
    <SlateModal onClose={done}>
      <SlateModalHead title={initial ? "Rename project" : "New project"} onClose={done} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const parsed = projectNameSchema.safeParse(v.trim() || (initial ? undefined : "Project"));
          if (!parsed.success) {
            setErr(parsed.error.issues[0]?.message ?? "Invalid name");
            return;
          }
          if (initial) {
            void renameProject(initial.id, parsed.data).then(
              () => push("Project renamed", { icon: "check" }),
              () => push("Rename failed — is the server running?", { icon: "!", tone: "danger" }),
            );
          } else {
            void createProject(parsed.data).then(
              (id) => {
                push("Project created", { icon: "plus" });
                router.push(`/p/${id}/generate`);
              },
              () => push("Create failed — is the server running?", { icon: "!", tone: "danger" }),
            );
          }
          done();
        }}
        className="space-y-3"
      >
        <div>
          <SlateLabel htmlFor="pname">Project name</SlateLabel>
          <SlateField
            id="pname"
            value={v}
            onChange={(e) => setV(e.target.value)}
            placeholder="e.g. Neon Launch Film"
            maxLength={60}
            autoComplete="off"
          />
          {err && <p className="text-[12px] text-[#C9432E] mt-1">{err}</p>}
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" size="sm" onClick={done}>
            Cancel
          </SlateButton>
          <SlateButton variant="primary" size="sm" type="submit">
            {initial ? "Save" : <><Plus className="size-3.5" /> Create</>}
          </SlateButton>
        </div>
      </form>
    </SlateModal>
  );
}

function DeleteProjectConfirm({ id, name, done }: { id: string; name: string; done: () => void }) {
  const deleteProject = useStudio((s) => s.deleteProject);
  const push = useToasts((s) => s.push);
  const single = useStudio((s) => s.projects.length <= 1);
  return (
    <SlateModal onClose={done}>
      <h3 className="font-display font-bold text-[16px]">Delete “{name}”?</h3>
      <p className="mt-1.5 text-[13.5px] text-fg2 leading-relaxed">
        Its library, elements and history go with it. This cannot be undone.
        {single ? " This is your last project — you'll land on a fresh start screen." : ""}
      </p>
      <div className="mt-5 flex gap-2 justify-end">
        <SlateButton variant="ghost" onClick={done}>
          Cancel
        </SlateButton>
        <SlateButton
          variant="danger"
          onClick={() => {
            void deleteProject(id).then(
              () => {
                push("Project deleted", { icon: "trash", tone: "info" });
                done();
              },
              () => push("Delete failed — is the server running?", { icon: "!", tone: "danger" }),
            );
          }}
        >
          Delete project
        </SlateButton>
      </div>
    </SlateModal>
  );
}

export function SlateOptRow(props: {
  active?: boolean;
  onPick: () => void;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return <SlateOption active={props.active} onPick={props.onPick} onClose={props.onClose}>{props.children}</SlateOption>;
}
