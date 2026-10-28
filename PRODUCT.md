# Product

## Register

product

## Users

Homelab owners and small self-hosters who run one or more Linux servers (often headless, reached over SSH or Tailscale) and manage them from a Windows desktop. They know what a service, a log and a user account are, but they do not want to live in a terminal for routine checks. Typical moments: a quick health glance, restarting a misbehaving service, reading why something failed, moving files, adding a user, opening a shell when needed.

## Product Purpose

NodeScape is a desktop control panel for Linux servers over plain SSH, with nothing installed on the server. It shows health, services, processes, logs, schedules, files, users and network state, and offers a terminal and safe, confirmed actions (per-action sudo, strict host keys, no stored passwords). Success: routine server care is faster and calmer than SSH by hand, and the user trusts every action the app takes.

## Brand Personality

Calm, precise, trustworthy. A quiet control room: dense, well-ordered information; nothing shouts; status is clear at a glance; destructive actions feel deliberate and safe. Inner pages take cues from Linear and Raycast: tight, sharp, low-radius surfaces, strong typography, dense readable lists.

## Anti-references

- Bubbly rounded SaaS: pill buttons and big rounded cards everywhere.
- Dark hacker theme: neon on black, terminal cosplay.
- Old enterprise admin: grey 2010 control panels, tiny fonts, endless forms.
- Generic AI dashboard: gradient hero metrics, glassmorphism, identical card grids.

## Design Principles

1. Calm by default, loud only for problems: failed, denied and unknown states earn color; healthy states stay quiet.
2. Density with order: show more per screen through alignment, typography and rhythm, not through more boxes.
3. Every action is legible: what it does, to what, on which server, and whether it needs a password, before it runs.
4. One system, every page: inner pages use the same structure, components and rhythm as the Overview.
5. Honest data: unavailable is shown as unavailable, never as zero; errors say what happened and what to do.

## Accessibility & Inclusion

WCAG 2.2 AA: text contrast at least 4.5:1 (3:1 for large text), visible keyboard focus, full keyboard operation, status never conveyed by color alone, respects reduced motion, usable from 800x600 to 2560x1440.
