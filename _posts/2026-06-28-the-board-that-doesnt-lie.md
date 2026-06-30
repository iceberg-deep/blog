---
layout: post
title: "The Board That Doesn't Lie."
subtitle: "Why I Replaced Jira With Three Flat Files and a Conscience."
date: 2026-06-28 16:00:00 -0700
description: "Every project rots in the gap between what you think is done and what's actually done. PMMS is a dashboard with no build step that turns status into a file you can git diff ... and refuses to call a green board good."
image: /assets/og/the-board-that-doesnt-lie.png
tags: [devtools, open-source, pmms]
---

Everybody in the standup has a status, and almost nobody can actually prove it. The card says done. The person says basically done. The chart says on track, in the same calm voice your friend uses to say he's almost at your house when he hasn't even left yet. So before the next status meeting turns into a little séance, let's do the boring part and ask the rude question ... done according to what, and where is it written down?

```
        T H E   B O A R D
        =========================
          what you BELIEVE is done
                    vs
          what is ACTUALLY done
        =========================
          the gap between them is
          where projects go to die
        _________________________
        standup   >>>>>>>   the séance
        git diff  >>>>>>>   the autopsy
                                    真
```

So pour yourself something dark, and let me show you the cheapest project tool I've ever built. It's also the only one that ever told me the truth.

## 0x01 · the thing itself

PMMS. Project Monitoring and Management System. Three HTML pages, a little plain JavaScript, and a few flat files. No build step. No framework. No giant node_modules folder eating your hard drive. No CDN phoning home, no tracking, no paid tier where the good stuff is locked away. If the internet died tonight, the board would still open off your laptop like nothing happened.

Think of Jira as a whole city, with traffic and parking and a mayor. I just wanted a pocket knife.

What you get is three rooms ... a kanban board, a decision log, and a dashboard with graphs. You drop it into a project, open the folder, and it reads a few files and tells you where things really stand. That's the whole pitch. Nothing to sign up for, and nothing that can shut down and take your board with it.

## 0x02 · the gap nobody diffs

Projects don't rot in the code. They rot in the space between the story you tell about the work and the work itself.

It's like a group project. Everyone swears they did their part, right up until you open the slideshow the night before it's due and half the slides are blank. Nobody lied on purpose. They just said on track, because the other choice was admitting out loud, in front of everyone, that the thing they promised was finished had never even been started. So the gap grows quietly, one nod at a time, until the day it stops being a gap and becomes a crater with your due date sitting at the bottom.

You can't measure a nod. You can't fact check a vibe. That's the whole problem, and it's the only one PMMS was built to kill.

## 0x03 · status becomes a file

Here's the one idea the whole thing stands on. The board, the log, and the metrics are just plain files inside the project ... kanban-board.json, decisions.md, metrics.json ... and the pages build everything right in your browser from those files.

So status stops being a story someone tells and becomes a thing that actually exists on disk. Think of it like a video game save file. Telling your friend you beat the final boss is just words. The save file is proof. With PMMS, a card moves only when a file changes, and a decision counts only when it has a real line you can point at. You can line up the project's honesty on Monday against Friday and see exactly who changed what, and when.

And decisions don't get deleted here. They get crossed out and replaced, with the old one still sitting there, faded, pointing at the new one. The graveyard keeps its dead. That's not me being dramatic. It's so future you can't pretend past you never made the call.

## 0x04 · the part that should scare you

Read this part twice, because most dashboards are too scared to print it.

A green board means tracked. For the test tiles it also means the build and tests passed. That's all it means. It does not mean the project is good. It does not mean people are happy. It does not mean you built the thing anyone actually wanted.

It's like cleaning your room by shoving everything into the closet. From the doorway it looks spotless. Open the closet and the truth falls on your head. A wall of green is exactly what a doomed project looks like, right up until the morning it doesn't.

So PMMS makes you split status into two piles and say both out loud.

✓ machine checked ... what the build and the tests actually prove.
✓ needs a human ... everything else. If that pile is empty, you're not finished thinking, you're just finished typing.

The dashboard can count. It can't understand. Mix those two up and you'll ship a really good looking corpse.

## 0x05 · the receipts

Every honest tool should eat its own cooking, so PMMS tracks its own progress on its own board. The screenshots in the repo are exactly that ... the board that built the board.

```
        WHAT IT IS                 WHAT IT ISN'T
        ==========                 =============
        3 html files               a platform
        flat files (git diff)      a database
        runs from file://          a cloud login
        0 dependencies             a node_modules crater
        MIT, fork it               a free trial
        honest about being green   "done"
```

It comes with a tiny local server for the live view, a private sharing setup over Tailscale that never reaches the open internet, and a sync script so updates don't stomp on your data. All of it boring on purpose. Boring is the stuff that survives.

## 0x06 · the honest caveat

Because this is still the honest blog, the knife has to cut back at me too.

PMMS is only as honest as the person keeping the files updated. Let the board sit and it will lie to you with a perfectly straight face and a perfectly green tile. A file has no conscience of its own. It only holds yours. Think of it like the scoreboard at a game. The scoreboard doesn't make you good. It just makes it really hard to lie about the score. Stop updating it, and it isn't a scoreboard anymore, it's just a nicer place to keep your excuses.

Tracked still isn't the same as good. But untracked is so much worse, and we both know which way things drift when nobody is writing anything down.

So hold both ideas at once. The board can't make you honest. All it can do is make lying take effort, and leave fingerprints when you try. Most days, that's enough.

It's free and open, MIT licensed. Take it, fork it, delete the ASCII art if you want. Just keep the honesty part, because that was always the whole point. → github.com/iceberg-deep/pmms

## 0x07 · outro

```
status was a story. now it's a file.
green means tracked, not good ... don't confuse a clean closet with a clean room.
your project isn't dying in the code. it's dying in the gap you won't look at.

check your status. write down your dead. wear black.

                                                            EOF
```
