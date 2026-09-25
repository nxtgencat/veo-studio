// Mock seed only. All mock data lives in /mock — UI imports via lib/stores, never inline.
import { SAMPLE_VIDEOS } from "@/mock/catalog.mock";
import { pic, uid } from "@/lib/format";
import type { Project } from "@/lib/schemas";

export const blankGen = () => ({
  mode: "t2v" as const,
  model: "veo-3.1-fast-generate-001",
  res: "1080p" as const,
  aspect: "16:9" as const,
  dur: 8,
  audio: true,
  batch: 1,
  seed: "" as string | number,
  person: "allow_adult" as const,
  enhance: true,
  prompt: "",
  image: "",
  first: "",
  last: "",
  refs: [] as string[],
  extendVideo: "",
});

export const blankProject = (name: string): Project => ({
  id: uid("prj"),
  name: name || "Untitled project",
  createdAt: Date.now(),
  gen: blankGen(),
  library: [],
  elements: { characters: [], locations: [], assets: [], frames: [] },
  settings: { saJson: "", bucket: "", ytClientId: "", ytPrivacy: "unlisted", ytCategory: "22" },
});

export function seedStudio(): { projects: Project[]; activeId: string } {
  const p = blankProject("Neon Launch Film");
  p.settings.bucket = "my-veo-output-12345";
  p.library = [
    {
      id: uid("vid"), mode: "t2v",
      prompt: "Low-angle close-up of a founder unveiling a glowing product on a dark stage, cinematic haze, slow dolly in",
      model: "veo-3.1-fast-generate-001", res: "1080p", aspect: "16:9", dur: 8, audio: true,
      seed: 42137, person: "allow_adult", enhance: true, batch: 1,
      status: "success", cost: 0.96, createdAt: Date.now() - 864e5,
      thumb: pic("aivs-neon-stage"), url: SAMPLE_VIDEOS[0], progress: 100, error: "", inputs: {},
    },
    {
      id: uid("vid"), mode: "r2v",
      prompt: "The character walks through a rain-lit night market, neon reflections, steady tracking shot",
      model: "veo-3.1-generate-001", res: "1080p", aspect: "9:16", dur: 8, audio: true,
      seed: 90312, person: "allow_adult", enhance: true, batch: 1,
      status: "success", cost: 3.2, createdAt: Date.now() - 43e5,
      thumb: pic("aivs-night-market", 640, 1120), url: SAMPLE_VIDEOS[2], progress: 100, error: "",
      inputs: { refs: [pic("aivs-face-ref", 300, 300)] },
    },
    {
      id: uid("vid"), mode: "i2v",
      prompt: "Camera slowly pushes in as lanterns lift into the night sky",
      model: "veo-3.1-lite-generate-001", res: "720p", aspect: "16:9", dur: 6, audio: false,
      seed: "", person: "allow_adult", enhance: true, batch: 1,
      status: "failed", cost: 0, createdAt: Date.now() - 2e5,
      thumb: pic("aivs-lantern"), url: "", progress: 100,
      error: "RESOURCE_EXHAUSTED: quota exceeded in us-central1. Retry with backoff.",
      inputs: { image: pic("aivs-lantern") },
    },
  ];
  p.elements.characters = [{ id: uid("el"), name: "Mara — lead", img: pic("aivs-face-ref", 300, 300), note: "Freckles, short bob" }];
  p.elements.locations = [{ id: uid("el"), name: "Night market", img: pic("aivs-night-market", 400, 300), note: "Wet asphalt, neon" }];
  p.elements.assets = [{ id: uid("el"), name: "Glass product", img: pic("aivs-product", 400, 300), note: "Hero prop" }];
  p.elements.frames = [{ id: uid("el"), name: "Stage wide", img: pic("aivs-neon-stage", 400, 225), note: "From first video" }];
  return { projects: [p], activeId: p.id };
}
