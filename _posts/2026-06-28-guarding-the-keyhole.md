---
layout: post
title: "Guarding the Keyhole"
subtitle: "How Defenders Actually Catch a Distillation Attack"
date: 2026-06-28 02:00:00 +0000
description: "You cannot lock a door that has to answer paying customers. So how do you actually catch a distillation attack? Read the shape of the traffic, salt the outputs, and price the heist."
image: /assets/og/guarding-the-keyhole.png
tags: [ai-security, defense, distillation]
---

You cannot lock a door that has to stay open. That is the whole defensive problem in one sentence. The API exists to answer paying customers, and the extractor is paying, or at least laundering money that looks enough like paying. You cannot block the queries without blocking the business. So defense against a distillation attack is not a lock. It is everything you do once you accept that the door stays open.

```
        T H E   K E Y H O L E ,   W A T C H E D
        =======================================
        queries  )))  )))  )))  )))  )))   the sweep
                  \                   /
                   \     one shape   /
                    v               v
                 [ S E N T R Y ]   reads the pattern,
                                   not the question
                       |
                       v
        every answer leaves wearing a mark.
        clone the answers, you clone the mark.
                                            守
```

## 0x01 · you cannot lock the door

Start by killing the fantasy where you just turn it off. The model is a product. It answers questions for a living. The extraction traffic is, request by request, indistinguishable from a power user who genuinely loves your software engineering benchmark. There is no single query that screams theft. The crime only exists in aggregate, in the shape of twenty five thousand accounts asking the same kind of expensive question for six weeks.

So you do not defend the door. You defend the room behind it, on three fronts: see the attack, taint the loot, and raise the price of the heist.

## 0x02 · see the shape, not the request

Detection lives at the altitude where the pattern shows up. One account asking ten thousand coding questions trips an alarm. Ten thousand accounts asking one coding question each does not, unless you can see all ten thousand at once and notice they rhyme.

That is what the vendor in the first piece actually had: the view from inside, where the whole sweep is one object instead of a crowd. From there you fingerprint it. Coverage that is too even, too methodical, sweeping the capability surface like a scanner instead of stumbling like a human. Account cohorts that were born the same week, share a billing fingerprint, and only ever ask about the expensive stuff. Timing that looks like a cron job wearing a person costume. None of it is one smoking gun. All of it together is a confession.

## 0x03 · salt the well

You probably cannot stop them copying. So make the copy carry evidence.

This is the interesting front, and the most research stage, so hold it loosely. The idea is to watermark the outputs, to bias the model's word choices into a statistical pattern that is invisible to a reader but obvious to anyone holding the key. Seed canary responses, distinctive answers to rare prompts that no honest training set would ever contain. If a downstream model later reproduces your watermark or parrots your canary, you have a fingerprint that says this clone drank from my well. It does not prevent the theft. It converts theft into attribution, which is the whole distance between a rumor and a lawsuit.

The catch is that distillation is lossy by design, and a watermark can wash out in the same blur that smears the safety. So this is a probabilistic smell, not a serial number. Useful, not magic.

## 0x04 · raise the cost

If you cannot stop it and cannot always catch it, you make it expensive enough to hurt.

Friction on the front door: real identity checks, payment verification that a thousand burner signups cannot fake cheaply, rate limits that throttle a sweep without strangling a power user. Price the expensive capabilities like they are expensive, so twenty nine million queries against your best reasoning costs the attacker real money instead of a rounding error. Geofence and enforce the terms, not because a determined adversary cannot tunnel under them, but because every layer turns a quiet scrape into a loud, costly, traceable operation.

None of it is a wall. All of it is a tax. The goal is not zero theft. The goal is to make the cheapest path to a clone expensive enough that building your own starts to look reasonable.

## 0x05 · the honest caveat

Here is the part the vendor pitch leaves out. Every one of these defenses is also a tax on the people you actually want. Identity checks annoy legitimate users. Rate limits throttle your biggest fans. Aggressive anomaly detection flags the harmless weirdo who really does ask ten thousand coding questions. Defense is a dial, not a switch, and cranking it hurts the business you are protecting.

And a funded, patient adversary still walks off with a degraded copy. Defense does not buy you immunity. It buys you time, cost, and attribution, three things that turn an invisible bleed into a fight you can see and maybe litigate. That is the realistic win. Anyone selling you a model that cannot be copied is pushing the same snake oil as the people who swore it could never be stolen.

Hold both. You cannot lock the keyhole. You can absolutely make whoever looks through it regret the bill.

## 0x06 · outro

```
you cannot close the keyhole. it has to answer the room.
so you watch the shape, you salt the answers, you price the heist.
not a wall. a tax, a tripwire, and a fingerprint.

the thief still gets a copy. just not a clean one, and not a quiet one.

watch your traffic. mark your outputs. wear black.

                                                            EOF
```

---

*field note 3 of 4. previously: [Mythos]({{ '/2026/06/28/mythos.html' | relative_url }}).*
