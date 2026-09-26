"use client";

import { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Check, Pencil, Plus, Shapes, Trash2, Upload, WandSparkles } from "lucide-react";
import { EL_CATS } from "@/lib/catalog";
import { fileToImage } from "@/lib/media";
import { elementFormSchema, type ElementCat } from "@/lib/schemas";
import { useStudio } from "@/stores/use-studio";
import { useToasts } from "@/stores/use-ui";
import { useQueryState } from "@/hooks/use-studio-hooks";
import { SlateButton, SlateCloseButton } from "@/components/slate/button";
import { SlateDialog } from "@/components/slate/overlays";
import { PageHead, SlateEmpty, SlateField, SlateLabel, SlateSegmented } from "@/components/slate/core";
import { SlateModal, SlateModalHead } from "@/components/slate/overlays";

export function ElementsView() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;
  const project = useStudio((s) => s.projects.find((x) => x.id === projectId));
  const addElement = useStudio((s) => s.addElement);
  const attachElement = useStudio((s) => s.attachElement);
  const push = useToasts((s) => s.push);
  const router = useRouter();
  const { state, set } = useQueryState({ cat: "characters", add: "", del: "", rename: "", view: "" });
  const cat = (EL_CATS.some((c) => c.id === state.cat) ? state.cat : "characters") as ElementCat;
  const items = project?.elements[cat] ?? [];

  if (!project) return null;

  const useEl = (id: string) => {
    const el = items.find((x) => x.id === id);
    if (!el) return;
    attachElement(cat, el.img);
    router.push(`/p/${projectId}/generate`);
    push(cat === "frames" ? "Attached as frame" : "Attached as reference", { icon: "✦" });
  };

  return (
    <>
      <PageHead
        title="Elements"
        sub={`Reusable references for ${project.name}. “Use” attaches an item straight into the generator.`}
        actions={
          <SlateButton variant="primary" size="sm" onClick={() => set({ add: "1" })}>
            <Plus className="size-3.5" /> Add {cat.slice(0, -1)}
          </SlateButton>
        }
      />
      <SlateSegmented
        label="Element categories"
        scrollable
        className="mb-4"
        options={EL_CATS.map((c) => ({
          id: c.id as ElementCat,
          label: c.label,
          count: project.elements[c.id as ElementCat]?.length ?? 0,
        }))}
        value={cat}
        onChange={(v) => set({ cat: v })}
      />

      {!items.length ? (
        <SlateEmpty
          icon={<Shapes className="size-6 text-[#1C7247]" />}
          title={`No ${cat} yet`}
          sub="Save faces, places, props and stills here, then reuse them across every generation in this project."
          action={
            <SlateButton variant="primary" onClick={() => set({ add: "1" })}>
              <Plus className="size-3.5" /> Add {cat.slice(0, -1)}
            </SlateButton>
          }
        />
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
          {items.map((e) => (
            <article key={e.id} className="slate-card overflow-hidden">
              <button
                type="button"
                onClick={() => set({ view: e.id })}
                title={`View ${e.name}`}
                aria-label={`View ${e.name}`}
                className="block w-full aspect-[4/3] bg-surface2 relative cursor-zoom-in"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={e.img} className="absolute inset-0 w-full h-full object-cover" alt={e.name} loading="lazy" />
              </button>
              <div className="p-3">
                <p className="text-[13px] font-bold truncate">{e.name}</p>
                {e.note && <p className="text-[11.5px] text-muted truncate mt-0.5">{e.note}</p>}
                <div className="mt-2 flex gap-1.5">
                  <SlateButton variant="ghost" size="sm" className="flex-1" onClick={() => useEl(e.id)}>
                    <WandSparkles className="size-3.5" /> Use
                  </SlateButton>
                </div>
                <div className="mt-1.5 flex gap-1.5">
                  <SlateButton variant="ghost" size="sm" className="flex-1" onClick={() => set({ rename: e.id })}>
                    <Pencil className="size-3.5" /> Rename
                  </SlateButton>
                  <SlateButton variant="ghost" size="sm" className="flex-1" onClick={() => set({ del: e.id })}>
                    <Trash2 className="size-3.5" /> Delete
                  </SlateButton>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {state.add === "1" && (
        <ElementModal
          cat={cat}
          close={() => set({ add: "" })}
          save={async (img, name, note) => {
            const parsed = elementFormSchema.safeParse({ name: name.trim() || "Untitled", img, note: note.trim() });
            if (!parsed.success) {
              push(parsed.error.issues[0]?.message ?? "Invalid element", { icon: "!", tone: "danger" });
              return;
            }
            const r = await addElement(cat, { name: parsed.data.name, imageUrl: parsed.data.img, note: parsed.data.note });
            if (!r.ok) {
              push(r.error ?? "Could not add element", { icon: "!", tone: "danger" });
              return;
            }
            push("Element added", { icon: "✓" });
            set({ add: "" });
          }}
        />
      )}
      {state.del && (
        <DeleteElementConfirm cat={cat} id={state.del} close={() => set({ del: "" })} />
      )}
      {state.rename && (
        <RenameElementModal cat={cat} id={state.rename} close={() => set({ rename: "" })} />
      )}
      {state.view && (
        <ViewElementModal cat={cat} id={state.view} close={() => set({ view: "" })} />
      )}
    </>
  );
}

function ElementModal({
  cat, close, save,
}: {
  cat: ElementCat; close: () => void; save: (img: string, name: string, note: string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [up, setUp] = useState<string | null>(null);
  const push = useToasts((s) => s.push);

  return (
    <SlateModal onClose={close}>
      <SlateModalHead title={`Add ${cat.slice(0, -1)}`} onClose={close} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const img = up || url.trim();
          if (!img) {
            push("Add an image URL or upload a file", { icon: "!", tone: "danger" });
            return;
          }
          save(img, name, note);
          close();
        }}
        className="space-y-4"
      >
        <div>
          <SlateLabel>Name</SlateLabel>
          <SlateField value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mara — lead" />
        </div>
        <div>
          <SlateLabel>Image</SlateLabel>
          {up && (
            <div className="rounded-[10px] overflow-hidden border slate-hair h-[120px] mb-2 bg-surface2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={up} className="w-full h-full object-cover" alt="preview" />
            </div>
          )}
          <div className="flex gap-2">
            <SlateField
              className="font-mono !text-[12px]"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setUp(null); }}
              placeholder="https://… or upload a file"
            />
            <label className="slate-btn slate-btn-ghost slate-btn-sm shrink-0 cursor-pointer">
              <Upload className="size-3.5" /> File
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (!name.trim()) {
                    setName((f.name || "").replace(/\.[a-z0-9]+$/i, "").slice(0, 80) || "Upload");
                  }
                  fileToImage(f).then(setUp).catch(() => push("Could not read that image", { icon: "!", tone: "danger" }));
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </div>
        <div>
          <SlateLabel>Note <span className="text-muted font-normal">(kept fixed in prompts)</span></SlateLabel>
          <SlateField value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. freckles, short bob" />
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
          <SlateButton variant="primary" type="submit">Add</SlateButton>
        </div>
      </form>
    </SlateModal>
  );
}

function RenameElementModal({ cat, id, close }: { cat: ElementCat; id: string; close: () => void }) {
  const renameElement = useStudio((s) => s.renameElement);
  const project = useStudio((s) => s.projects.find((x) => x.id === (s.activeId ?? "")) ?? s.projects[0]);
  const push = useToasts((s) => s.push);
  const el = project?.elements[cat]?.find((x) => x.id === id);
  const [name, setName] = useState(el?.name ?? "");
  const [note, setNote] = useState(el?.note ?? "");
  const [busy, setBusy] = useState(false);
  if (!el) return null;
  const save = () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    void renameElement(id, { name, note }).then((r) => {
      setBusy(false);
      if (!r.ok) {
        push(r.error ?? "Could not rename", { icon: "!", tone: "danger" });
        return;
      }
      push("Element renamed", { icon: "✓" });
      close();
    });
  };
  return (
    <SlateModal onClose={close}>
      <SlateModalHead title={`Rename ${cat.slice(0, -1)}`} onClose={close} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className="space-y-4"
      >
        <div className="rounded-[10px] overflow-hidden border slate-hair h-[110px] bg-surface2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={el.img} className="w-full h-full object-cover" alt={el.name} />
        </div>
        <div>
          <SlateLabel>Name</SlateLabel>
          <SlateField value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mara — lead" autoFocus />
        </div>
        <div>
          <SlateLabel>Note <span className="text-muted font-normal">(kept fixed in prompts)</span></SlateLabel>
          <SlateField value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="e.g. freckles, short bob" />
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
          <SlateButton variant="primary" type="submit" disabled={busy || !name.trim()}>
            <Check className="size-3.5" /> {busy ? "Saving…" : "Save"}
          </SlateButton>
        </div>
      </form>
    </SlateModal>
  );
}

function ViewElementModal({ cat, id, close }: { cat: ElementCat; id: string; close: () => void }) {
  const project = useStudio((s) => s.projects.find((x) => x.id === (s.activeId ?? "")) ?? s.projects[0]);
  const attachElement = useStudio((s) => s.attachElement);
  const push = useToasts((s) => s.push);
  const router = useRouter();
  const el = project?.elements[cat]?.find((x) => x.id === id);
  if (!el || !project) return null;
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
        <>
          <SlateButton
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => {
              attachElement(cat, el.img);
              router.push(`/p/${project.id}/generate`);
              push(cat === "frames" ? "Attached as frame" : "Attached as reference", { icon: "✦" });
              close();
            }}
          >
            <WandSparkles className="size-3.5" /> Use in generator
          </SlateButton>
        </>
      }
    >
      <div className="rounded-[10px] overflow-hidden border slate-hair bg-surface2 grid place-items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={el.img} className="w-full max-h-[62dvh] object-contain" alt={el.name} />
      </div>
      {el.note && <p className="mt-2.5 text-[13px] text-fg2 leading-relaxed">{el.note}</p>}
    </SlateDialog>
  );
}

function DeleteElementConfirm({ cat, id, close }: { cat: ElementCat; id: string; close: () => void }) {  const deleteElement = useStudio((s) => s.deleteElement);
  const project = useStudio((s) => s.projects.find((x) => x.id === (s.activeId ?? "")) ?? s.projects[0]);
  const push = useToasts((s) => s.push);
  const el = project?.elements[cat]?.find((x) => x.id === id);
  if (!el) return null;
  return (
    <SlateModal onClose={close}>
      <h3 className="font-display font-bold text-[16px]">Delete “{el.name}”?</h3>
      <p className="mt-1.5 text-[13.5px] text-fg2 leading-relaxed">
        Removes it from Elements. Videos already generated from it are not affected.
      </p>
      <div className="mt-5 flex gap-2 justify-end">
        <SlateButton variant="ghost" onClick={close}>Cancel</SlateButton>
        <SlateButton
          variant="danger"
          onClick={() => {
            void deleteElement(id).then(() => push("Element deleted", { icon: "🗑", tone: "info" }));
            close();
          }}
        >
          Delete
        </SlateButton>
      </div>
    </SlateModal>
  );
}
