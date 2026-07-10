# AUGUR instructions file

## What this is

The Claude Code build for an application that runs a heuristic review and an accessibility test for any URL.

## Structure

Page title, short description, form field to enter any URL, action button to submit.

Below this, two tabs: Heuristics and Accessibility.

Heuristic Evaluation information will appear in the Heuristics tab, Accessibility information will appear in the Accessibility tab.



## Method

An API call is made to the Claude API when the user clicks the submit button. Any information in the form field is sent to the API. The returned information will be displayed below the form field.

## Colors

- slate-dark: #16333F
- slate-light: #2D4550
- amber-bright: #FFE093
- grey-standard: #D7EAF9
- grey-subtle: #A9BDD8
- red-light: #D2B7BB
- red-dark: #5A0915
- orange-light: #ECC9C0
- orange-dark: #571E0F
- amber-light: #EDDFCA
- amber-dark: #442904
- yellow-light: #E7E6C8
- yellow-dark: #383600
- green-light: #CCE4C0
- green-dark: #133D00
- jade-light: #BEEECC
- jade-dark: #003D11

## Fonts

Font: Montserrat (Google Fonts)
Weights needed: 300, 400, 500, 600, 700, 800



---

## Empty state copy

This copy is to appear below the tabs before a URL is submitted to the API:

**What are heuristics, and what is accessibility?**

Heuristics and accessibility are the two lenses that separate a site that merely displays content from one that actually works for the person in front of it — heuristics judging how clearly it's structured and how predictably it behaves, accessibility ensuring it behaves that way for everyone, regardless of how they see, hear, or navigate the web.

Heuristics are a set of proven standards for evaluating how a design is structured and how people interact with it — not what the content says, but how clearly it's organized, how predictably it behaves, and how easily someone can accomplish what they came to do. Good heuristics don't just catch mistakes after the fact; they shape better design decisions from the start.

Accessibility is the practice of designing so that people with different abilities can use a site fully — including people who are blind or low-vision, deaf or hard of hearing, or who navigate by keyboard, switch device, or screen reader rather than a mouse or touch. An accessible site offers more than one way to see, hear, and interact with its content, so no one is excluded from using it because of how their body or senses work.

For heuristic evaluations, AUGUR uses the Nielsen-Norman Group's ten usability heuristics, developed by Jakob Nielsen and Don Norman, who have been the industry's reference standard for usability evaluation since 1994 — tested, refined, and taught in nearly every design program and referenced across the field ever since. They remain the closest thing UX has to a shared, common vocabulary for what makes an interface work.

For accessibility standards, AUGUR references The Web Content Accessibility Guidelines (WCAG), which are the most widely adopted accessibility standard in the world, referenced by legal requirements and design systems across industries. AUGUR evaluates against WCAG 2.2*, which adds updated criteria for mobile and touch interaction on top of the existing standard.

AUGUR brings both standards into one tool. Enter any URL and get a heuristic evaluation and an accessibility evaluation side by side — what's working, what needs attention, how severe each issue is, and specific, actionable recommendations for fixing it. One check, both lenses, no guesswork.

\* A note on WCAG 3.0: A newer version, WCAG 3.0, is currently in development but remains an incomplete draft, with a final standard not expected until 2027. AUGUR evaluates against WCAG 2.2 — the current, legally referenced standard — and will update as the field does.

---

## Process

Build code efficiently. Have a plan for how you will execute commands and requests to change features and code. Report the plan to me, especially for high-effort changes. Save on token spend wherever and however you can.

### Suggestions, questions, ideas, recommendations

I am open to recommendations, suggestions, new ideas. If you have a better way of achieving a goal, or a recommendation for how to achieve it, feel free to tell me. If there is anything unclear or that does not make sense in a command or request, please surface this and ask clarifying questions.
