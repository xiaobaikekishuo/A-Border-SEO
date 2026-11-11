import type { ContentPlan } from "./types";

export function examplePlan(): ContentPlan {
  return {
    pillarSummary: "A balanced editorial plan requiring review.",
    topics: (["TOFU", "MOFU", "BOFU"] as const).map((funnel, index) => ({
      title: `Cup guide ${index}`, keyword: `cup question ${index}`, funnel,
      intent: "Understand the available choices", contentType: "Guide",
      brief: {
        summary: "Explain the topic clearly.", audience: "Home cooks", searchIntent: "Find a suitable cup",
        angle: "Practical guidance with verified facts", outline: ["Question", "Considerations", "Next steps"],
        keyPoints: ["Verify product details"], cta: "Review your requirements.", internalLinks: [],
        evidenceNotes: ["No search volume data is available; editorial review is required."],
      },
    })),
  };
}
