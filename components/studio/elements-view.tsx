"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, Pencil, Plus, Shapes, Trash2, Upload, WandSparkles } from "lucide-react";
import { EL_CATS } from "@/lib/catalog";
import { fileToImage } from "@/lib/media";
import { elementFormSchema, type ElementCat } from "@/lib/schemas";
import { useStudio } from "@/stores/use-studio";
import { pushErr, useToasts } from "@/stores/use-ui";
import { useElements, useQueryState } from "@/hooks/use-studio-hooks";
import { SlateButton, SlateCloseButton, SlateIconButton } from "@/components/slate/button";
import { PageHead, SlateEmpty, SlateField, SlateLabel, SlateSegmented, SlateTextarea } from "@/components/slate/core";
import { ConfirmDeleteDialog, SlateDialog, SlateModal, SlateModalHead } from "@/components/slate/overlays";
import { SlateTooltip } from "@/components/slate/tooltip";

export function ElementsView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const exists = useStudio((s) => s.projects.some((p) => p.id === projectId));
  const name = useStudio((s) => s.projects.find((p) => p.id === projectId)?.name ?? "");
  const elements = useElements(projectId);
  const attachElement = useStudio((s) => s.attachElement);
  const push = useToasts((s) => s.push);
  const router = useRouter();
  const { state, set } = useQueryState({ cat: "characters", add: "", del: "", rename: "", view: "" });
  const cat = (EL_CATS.some((c) => c.id === state.cat) ? state.cat : "characters") as ElementCat;
  const items = elements[cat] ?? [];

  const useEl = (id: string) => {
    const el = items.find((e) => e.id === id);
    if (!el) return;
    attachElement(projectId, cat, el.img);
    push(cat === "frames" ? "Attached as frame" : "Attached as reference", { icon: "sparkles" });
    router.push(`/p/${projectId}/generate`);
  };

  if (!exists) return null;
  const catLabel = EL_CATS.find((c) => c.id === cat)?.label ?? cat;

  return (
    <>
      <PageHead
        title="Elements"
        sub={`Reusable references for ${name}. “Use” attaches them to the composer.`}
        actions={
          <SlateButton variant="primary" size="sm" onClick={() => set({ add: "1" })}>
            <Plus className="size-3.5" /> Add {catLabel.slice(0, -1)}
          </SlateButton>
        }
      />
      <SlateSegmented
        label="Element categories"
        scrollable
        className="mb-4"
        options={EL_CATS.map((c) => ({ id: c.id, label: c.label, count: elements[c.id as ElementCat]?.length ?? 0 }))}
        value={cat}
        onChange={(v) => set({ cat: v })}
      />
      {!items.length ? (
        <SlateEmpty
          icon={<Shapes className="size-6 text-[#1C7247]" />}
          title={`No ${cat} yet`}
          sub="Save faces, places, props and stills here, then reuse them in the generator."
          action={
            <SlateButton variant="primary" onClick={() => set({ add: "1" })}>
              <Plus className="size-3.5" /> Add {catLabel.slice(0, -1)}
            </SlateButton>
          }
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {items.map((el) => (
            <div key={el.id} className="slate-card overflow-hidden">
              <SlateTooltip tip={`View ${el.name}`}>
                <button
                  type="button"
                  onClick={() => set({ view: el.id })}
                  className="block w-full aspect-[4/3] bg-surface2 cursor-zoom-in relative"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={el.img} className="absolute inset-0 w-full h-full object-cover" alt="" loading="lazy" />
                </button>
              </SlateTooltip>
              <div className="p-3">
                <p className="text-[13px] font-bold truncate">{el.name}</p>
                {el.note && <p className="text-[11.5px] text-muted truncate">{el.note}</p>}
                <div className="mt-2 flex gap-1.5">
                  <SlateButton variant="ghost" size="sm" className="flex-1" onClick={() => useEl(el.id)}>
                    <WandSparkles className="size-3.5" /> Use
                  </SlateButton>
                  <SlateIconButton variant="ghost" size="icon-sm" label="Rename" onClick={() => set({ rename: el.id })}>
                    <Pencil className="size-3.5" />
                  </SlateIconButton>
                  <SlateIconButton variant="ghost" size="icon-sm" label="Delete" onClick={() => set({ del: el.id })}>
                    <Trash2 className="size-3.5" />
                  </SlateIconButton>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {state.add === "1" && (
        <ElementModal
          cat={cat}
          close={() => set({ add: "" })}
          save={async (img, nm, note) => {
            const parsed = elementFormSchema.safeParse({ name: nm.trim() || "Untitled", img, note: note.trim() });
            if (!parsed.success) {
              pushErr(parsed.error.issues[0]?.message ?? "Invalid element");
              return;
            }
            const r = await useStudio.getState().addElement(projectId, cat, {
              name: parsed.data.name,
              imageUrl: parsed.data.img,
              note: parsed.data.note,
            });
            if (!r.ok) {
              pushErr(r.error ?? "Could not add element");
              return;
            }
            push("Element added", { icon: "check" });
            set({ add: "" });
          }}
        />
      )}
      {state.rename && <RenameElementModal projectId={projectId} cat={cat} id={state.rename} close={() => set({ rename: "" })} />}
      {state.view && <ViewElementModal projectId={projectId} cat={cat} id={state.view} close={() => set({ view: "" })} onUse={useEl} />}
      {state.del && <DeleteElementConfirm projectId={projectId} cat={cat} id={state.del} close={() => set({ del: "" })} />}
    </>
  );
}

function ElementModal({ cat, close, save }: { cat: ElementCat; close: () => void; save: (img: string, name: string, note: string) => void }) {
  const [nm, setNm] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [up, setUp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <SlateModal onClose={close}>
      <SlateModalHead title={`Add ${cat.slice(0, -1)}`} onClose={close} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const img = up || url.trim();
          if (!img) {
            pushErr("Add an image URL or upload a file");
            return;
          }
          if (busy) return;
          setBusy(true);
          void Promise.resolve(save(img, nm, note)).finally(() => setBusy(false));
          close();
        }}
        className="space-y-3"
      >
        {up && (
          <div className="rounded-[10px] overflow-hidden border slate-hair h-[120px] bg-surface2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={up} className="w-full h-full object-cover" alt="" />
          </div>
        )}
        <div>
          <SlateLabel htmlFor="el-name">Name</SlateLabel>
          <SlateField id="el-name" value={nm} onChange={(e) => setNm(e.target.value)} placeholder="e.g. Mara Voss" maxLength={80} autoComplete="off" />
        </div>
        <div>
          <SlateLabel htmlFor="el-url">Image URL</SlateLabel>
          <SlateField id="el-url" value={url} onChange={(e) => { setUrl(e.target.value); setUp(null); }} placeholder="https://…" autoComplete="off" />
        </div>
        <div>
          <label className="slate-btn slate-btn-ghost slate-btn-sm cursor-pointer">
            <Upload className="size-3.5" /> Upload file
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                fileToImage(f)
                  .then((dataUrl) => {
                    setUp(dataUrl);
                    if (!nm.trim()) setNm((f.name || "Upload").replace(/\.[a-z0-9]+$/i, "").slice(0, 80));
                  })
                  .catch(() => pushErr("Could not read that image"));
                e.target.value = "";
              }}
            />
          </label>
        </div>
        <div>
          <SlateLabel htmlFor="el-note">Note</SlateLabel>
          <SlateTextarea id="el-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What to remember…" maxLength={200} />
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" size="sm" onClick={close}>Cancel</SlateButton>
          <SlateButton variant="primary" size="sm" type="submit" disabled={busy}>
            {busy ? "Saving…" : <><Check className="size-3.5" /> Save</>}
          </SlateButton>
        </div>
      </form>
    </SlateModal>
  );
}

function RenameElementModal({ projectId, cat, id, close }: { projectId: string; cat: ElementCat; id: string; close: () => void }) {
  const elements = useElements(projectId);
  const renameElement = useStudio((s) => s.renameElement);
  const push = useToasts((s) => s.push);
  const el = (elements[cat] ?? []).find((e) => e.id === id);
  const [nm, setNm] = useState(el?.name ?? "");
  const [note, setNote] = useState(el?.note ?? "");
  const [busy, setBusy] = useState(false);
  if (!el) return null;
  return (
    <SlateModal onClose={close}>
      <SlateModalHead title={`Rename ${cat.slice(0, -1)}`} onClose={close} />
      <div className="rounded-[10px] overflow-hidden border slate-hair h-[110px] bg-surface2 mb-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={el.img} className="w-full h-full object-cover" alt="" />
      </div>
      <div className="space-y-3">
        <div>
          <SlateLabel htmlFor="elr-name">Name</SlateLabel>
          <SlateField id="elr-name" value={nm} onChange={(e) => setNm(e.target.value)} maxLength={80} autoComplete="off" autoFocus />
        </div>
        <div>
          <SlateLabel htmlFor="elr-note">Note</SlateLabel>
          <SlateTextarea id="elr-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" size="sm" onClick={close}>Cancel</SlateButton>
          <SlateButton
            variant="primary"
            size="sm"
            disabled={busy || !nm.trim()}
            onClick={() => {
              if (busy || !nm.trim()) return;
              setBusy(true);
              void renameElement(id, { name: nm, note }).then((r) => {
                setBusy(false);
                if (!r.ok) {
                  pushErr(r.error ?? "Could not rename");
                  return;
                }
                push("Element renamed", { icon: "check" });
                close();
              });
            }}
          >
            {busy ? "Saving…" : <><Check className="size-3.5" /> Save</>}
          </SlateButton>
        </div>
      </div>
    </SlateModal>
  );
}

function ViewElementModal({ projectId, cat, id, close, onUse }: { projectId: string; cat: ElementCat; id: string; close: () => void; onUse: (id: string) => void }) {
  const elements = useElements(projectId);
  const el = (elements[cat] ?? []).find((e) => e.id === id);
  if (!el) return null;
  return (
    <SlateDialog
      onClose={close}
      header={
        <>
          <span className="text-[14px] font-bold truncate">{el.name}</span>
          <SlateCloseButton onClick={close} />
        </>
      }
      footer={
        <SlateButton variant="primary" size="sm" className="ml-auto" onClick={() => { onUse(el.id); close(); }}>
          <WandSparkles className="size-3.5" /> Use in generator
        </SlateButton>
      }
    >
      <div className="rounded-[10px] overflow-hidden border slate-hair bg-surface2 grid place-items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={el.img} className="max-h-[62dvh] w-auto max-w-full object-contain" alt={el.name} />
      </div>
      {el.note && <p className="text-[13px] text-fg2 leading-relaxed mt-3">{el.note}</p>}
    </SlateDialog>
  );
}

function DeleteElementConfirm({ projectId, cat, id, close }: { projectId: string; cat: ElementCat; id: string; close: () => void }) {
  const elements = useElements(projectId);
  const deleteElement = useStudio((s) => s.deleteElement);
  const push = useToasts((s) => s.push);
  const el = (elements[cat] ?? []).find((e) => e.id === id);
  if (!el) return null;
  return (
    <ConfirmDeleteDialog
      title={`Delete “${el.name}”?`}
      body="Removes it from Elements. Videos already generated are not affected."
      action="Delete element"
      close={close}
      confirm={() => {
        void deleteElement(id).then(() => push("Element deleted", { icon: "trash", tone: "info" }));
        close();
      }}
    />
  );
}
