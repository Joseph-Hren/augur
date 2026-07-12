"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";

const PHRASES = [
  "...evaluating...",
  "...running heuristics...",
  "...testing accessibility...",
  "...looking at layout...",
  "...checking the markup...",
  "...pondering design standards...",
  "...considering recommendations...",
  "...weighing severity...",
  "...mapping the hierarchy...",
  "...scanning the structure...",
];
const PHRASE_FADE_MS = 720;
const PHRASE_HOLD_MS = 2200;

const PLACEHOLDER_INTRO = "What are heuristics, and what is accessibility?";

const PLACEHOLDER_PARAGRAPHS = [
  "Heuristics and accessibility are the two lenses that separate a site that merely displays content from one that actually works for the person in front of it — heuristics judging how clearly it's structured and how predictably it behaves, accessibility ensuring it behaves that way for everyone, regardless of how they see, hear, or navigate the web.",
  "Heuristics are a set of proven standards for evaluating how a design is structured and how people interact with it — not what the content says, but how clearly it's organized, how predictably it behaves, and how easily someone can accomplish what they came to do. Good heuristics don't just catch mistakes after the fact; they shape better design decisions from the start.",
  "Accessibility is the practice of designing so that people with different abilities can use a site fully — including people who are blind or low-vision, deaf or hard of hearing, or who navigate by keyboard, switch device, or screen reader rather than a mouse or touch. An accessible site offers more than one way to see, hear, and interact with its content, so no one is excluded from using it because of how their body or senses work.",
  "For heuristic evaluations, AUGUR uses the Nielsen-Norman Group's ten usability heuristics, developed by Jakob Nielsen and Don Norman, who have been the industry's reference standard for usability evaluation since 1994 — tested, refined, and taught in nearly every design program and referenced across the field ever since. They remain the closest thing UX has to a shared, common vocabulary for what makes an interface work.",
  "For accessibility standards, AUGUR references The Web Content Accessibility Guidelines (WCAG), which are the most widely adopted accessibility standard in the world, referenced by legal requirements and design systems across industries. AUGUR evaluates against WCAG 2.2, which adds updated criteria for mobile and touch interaction on top of the existing standard.",
  "AUGUR brings both standards into one tool. Enter any URL and get a heuristic evaluation and an accessibility evaluation side by side — what's working, what needs attention, how severe each issue is, and specific, actionable recommendations for fixing it. One check, both lenses, no guesswork.",
];

// Badge background/text colors and icon, keyed by the exact enum value the
// API returns. Severity and confidence badges use a status-specific dark
// text color; the working-quality badge always uses dark slate text
// (#16333f) regardless of tier — that's a real distinction from Figma, not
// an inconsistency.
const STATUS_STYLES = {
  Critical: { bg: "#d2b7bb", text: "#5a0915", icon: "critical" },
  Severe: { bg: "#ecc9c0", text: "#571e0f", icon: "severe" },
  Moderate: { bg: "#eddfca", text: "#442904", icon: "moderate" },
  Minor: { bg: "#e7e6c8", text: "#383600", icon: "minor" },
  "High Confidence": { bg: "#beeecc", text: "#003d11", icon: "great" },
  Confident: { bg: "#cce4c0", text: "#133d00", icon: "good" },
  Suspected: { bg: "#e7e6c8", text: "#383600", icon: "minor" },
  Uncertain: { bg: "#eddfca", text: "#442904", icon: "moderate" },
  Excellent: { bg: "#beeecc", text: "#16333f", icon: "great" },
  Efficient: { bg: "#beeecc", text: "#16333f", icon: "great" },
  Strong: { bg: "#cce4c0", text: "#16333f", icon: "good" },
  Adequate: { bg: "#cce4c0", text: "#16333f", icon: "good" },
};

// Card header background, keyed the same way — one dark color per severity
// tier, and two working-quality tiers sharing the good/great split.
const HEADER_BG = {
  Critical: "#5a0915",
  Severe: "#571e0f",
  Moderate: "#442904",
  Minor: "#383600",
  Adequate: "#133d00",
  Strong: "#133d00",
  Efficient: "#003d11",
  Excellent: "#003d11",
};

// The API applies a known normalization server-side, but that's a safety
// net for one specific observed case, not a guarantee — an enum in the
// schema shapes the model's output, it doesn't enforce it. If a value ever
// slips through unrecognized, degrade to a neutral look rather than the
// badge disappearing and the header going transparent.
const FALLBACK_STYLE = { bg: "#2d4550", text: "#d7eaf9", icon: null };

// "Uncertain" reads as more actionable with this longer form, but the
// underlying value stays "Uncertain" everywhere else (schema, STATUS_STYLES
// lookup, prompt) — this is a display-only relabel, not a data change.
const BADGE_LABELS = { Uncertain: "Uncertain: needs review" };

function Badge({ value }) {
  if (!value) return null;
  const style = STATUS_STYLES[value] ?? FALLBACK_STYLE;
  return (
    <span className={styles.badge} style={{ backgroundColor: style.bg, color: style.text }}>
      {style.icon && <img className={styles.badgeIcon} src={`/icons/${style.icon}.svg`} alt="" />}
      {BADGE_LABELS[value] ?? value}
    </span>
  );
}

function CardHeader({ title, badgeValue }) {
  const backgroundColor = HEADER_BG[badgeValue] ?? FALLBACK_STYLE.bg;
  return (
    <div className={styles.cardHeader} style={{ backgroundColor }}>
      <Badge value={badgeValue} />
      <p className={styles.cardHeaderTitle}>{title}</p>
    </div>
  );
}

function Field({ label, value, bright, spaced }) {
  return (
    <div>
      <p className={spaced ? `${styles.cardLabel} ${styles.cardLabelSpaced}` : styles.cardLabel}>
        {label}
      </p>
      <p className={bright ? `${styles.cardValue} ${styles.cardValueBright}` : styles.cardValue}>
        {value}
      </p>
    </div>
  );
}

// Shared by all three card types. Renders nothing when confidence is
// absent — true for every real, scan-derived accessibility card, which
// carry no confidence field at all (see AccessibilityCard).
function ConfidenceField({ confidence, reason }) {
  if (!confidence) return null;
  return (
    <div>
      <p className={`${styles.cardLabel} ${styles.cardLabelSpaced}`}>AI Confidence Level</p>
      <p className={styles.cardValue}>
        <Badge value={confidence} />
      </p>
      {reason && <p className={styles.confidenceReason}>{reason}</p>}
    </div>
  );
}

function WorkingCard({ item }) {
  return (
    <div>
      <CardHeader title={item.standard} badgeValue={item.rating} />
      <div className={styles.card}>
        <Field label="What's Working" value={item.summary} bright />
        <ConfidenceField confidence={item.confidence} reason={item.confidenceReason} />
      </div>
    </div>
  );
}

function HeuristicCard({ issue }) {
  return (
    <div>
      <CardHeader title={issue.standard} badgeValue={issue.severity} />
      <div className={styles.card}>
        <Field label="Issue" value={issue.title} bright />
        <Field label="Description" value={issue.description} />
        <Field label="Recommendation" value={issue.recommendation} />
        <Field
          label="Additional Heuristic Standards Considered"
          value={issue.secondaryStandards.length ? issue.secondaryStandards.join(", ") : "None"}
        />
        <ConfidenceField confidence={issue.confidence} reason={issue.confidenceReason} />
      </div>
    </div>
  );
}

function AccessibilityCard({ issue }) {
  return (
    <div>
      <CardHeader title={issue.standard} badgeValue={issue.severity} />
      <div className={styles.card}>
        <Field label="Issue" value={issue.title} bright />
        <Field label="Page Elements Affected" value={issue.elementsAffected} />
        <Field label="Explanation" value={issue.description} />
        <Field label="Recommendation" value={issue.recommendation} />
        {/* Every real, scan-derived card is verified fact and has no
            confidence field — only the synthetic "no violations found"
            card (see NO_VIOLATIONS_CARD in route.js) sets one. */}
        <ConfidenceField confidence={issue.confidence} reason={issue.confidenceReason} />
      </div>
    </div>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [selectedTab, setSelectedTab] = useState(null);
  // Fades OUT existing result/error content the instant a repeat submission
  // starts (no hold beforehand). Never fades anything IN — arrival is a
  // snap, not a transition. Placeholder is never subject to this; it just
  // stays visible for the entire first-ever loading period.
  const [fading, setFading] = useState(false);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [phraseVisible, setPhraseVisible] = useState(false);
  // { type: "placeholder" } | { type: "result", data } | { type: "error", message }
  // Only ever changes when new data actually arrives — never synchronously
  // on click. Whatever was already on screen (and whichever tab was
  // selected) stays exactly as-is (fading out, for a repeat submission)
  // until real data replaces it outright.
  const [body, setBody] = useState({ type: "placeholder" });

  // Cycles the loading phrase while loading is true: fade in, hold, fade
  // out, advance to the next phrase (wrapping after the last one) — which
  // re-triggers this effect to repeat, for as long as loading stays true.
  // The cleanup fires the instant loading flips false, so nothing lingers.
  useEffect(() => {
    if (!loading) {
      setPhraseVisible(false);
      return;
    }
    setPhraseVisible(true);
    const holdTimer = setTimeout(() => {
      setPhraseVisible(false);
    }, PHRASE_FADE_MS + PHRASE_HOLD_MS);
    const nextTimer = setTimeout(() => {
      setPhraseIndex((i) => (i + 1) % PHRASES.length);
    }, PHRASE_FADE_MS + PHRASE_HOLD_MS + PHRASE_FADE_MS);
    return () => {
      clearTimeout(holdTimer);
      clearTimeout(nextTimer);
    };
  }, [loading, phraseIndex]);

  async function handleGo() {
    setPhraseIndex(0);
    if (body.type !== "placeholder") {
      setFading(true);
    }
    setLoading(true);

    try {
      const res = await fetch("/api/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: query }),
      });
      const data = await res.json();
      if (res.ok) {
        setBody({ type: "result", data: data.data });
        // First-ever result: default to Heuristics. A repeat submission
        // keeps whichever tab was already selected.
        setSelectedTab((prev) => prev ?? "heuristics");
      } else {
        setBody({ type: "error", message: data.error });
      }
    } catch {
      // A network hiccup on the fetch to our own /api/react route, not a
      // backend-reported error — those come back through the res.ok/else
      // branch above with their own specific message already.
      setBody({ type: "error", message: "Whoops, something got messed up. Let's try that again." });
    } finally {
      setLoading(false);
      setFading(false);
    }
  }

  const tabsEnabled = !loading && body.type === "result";
  const bodyClassName = fading ? `${styles.result} ${styles.fadeOut}` : styles.result;

  return (
    <>
    <main className={styles.page}>
      <h1 className={styles.title}>AUGUR</h1>
      <p className={styles.subtitle}>
        UX Heuristic Evaluation &amp; Accessibility Test for any URL
      </p>

      <div className={styles.column}>
        <div className={styles.primaryAction}>
          <input
            type="text"
            className={styles.field}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleGo()}
            placeholder="Enter any valid URL"
          />
          <button className={styles.button} onClick={handleGo} disabled={loading}>
            {loading ? (
              <span className={styles.dots}>
                <span className={styles.dot} />
                <span className={styles.dot} />
                <span className={styles.dot} />
              </span>
            ) : (
              "Evaluate"
            )}
          </button>
        </div>

        <div className={styles.tabZone}>
          {loading ? (
            <p
              className={
                phraseVisible
                  ? `${styles.loadingPhrase} ${styles.loadingPhraseVisible}`
                  : styles.loadingPhrase
              }
            >
              {PHRASES[phraseIndex]}
            </p>
          ) : (
            tabsEnabled && (
              <div className={styles.tabRow}>
                <button
                  type="button"
                  className={
                    selectedTab === "heuristics" ? `${styles.tab} ${styles.tabActive}` : styles.tab
                  }
                  onClick={() => setSelectedTab("heuristics")}
                >
                  Heuristics
                </button>
                <button
                  type="button"
                  className={
                    selectedTab === "accessibility" ? `${styles.tab} ${styles.tabActive}` : styles.tab
                  }
                  onClick={() => setSelectedTab("accessibility")}
                >
                  Accessibility
                </button>
              </div>
            )
          )}
        </div>

        {body.type === "error" && (
          <div className={bodyClassName}>
            <p className={styles.errorMessage}>{body.message}</p>
          </div>
        )}

        {body.type === "result" && (
          <div className={bodyClassName}>
            <div className={styles.cardStack}>
              {selectedTab === "accessibility"
                ? body.data.accessibilityIssues.map((issue, i) => (
                    <AccessibilityCard key={i} issue={issue} />
                  ))
                : [
                    ...body.data.workingWell.map((item, i) => (
                      <WorkingCard key={`w${i}`} item={item} />
                    )),
                    ...body.data.heuristicIssues.map((issue, i) => (
                      <HeuristicCard key={`h${i}`} issue={issue} />
                    )),
                  ]}
            </div>
          </div>
        )}

        {body.type === "placeholder" && (
          <div className={bodyClassName}>
            <p className={styles.placeholderIntro}>{PLACEHOLDER_INTRO}</p>
            {PLACEHOLDER_PARAGRAPHS.map((text, i) => (
              <p key={i} className={styles.plainText}>
                {text}
              </p>
            ))}
          </div>
        )}
      </div>
    </main>
    <footer className={styles.footer}>
      AUGUR - a heuristic and accessibility evaluation tool. &copy; 2026 Joseph Hren (
      <a
        href="https://jrhren.com"
        className={styles.footerLink}
        target="_blank"
        rel="noopener noreferrer"
      >
        jrhren.com
      </a>
      )
    </footer>
    </>
  );
}
