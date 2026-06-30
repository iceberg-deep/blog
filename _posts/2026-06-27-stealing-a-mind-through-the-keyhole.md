---
layout: post
title: "Stealing a Mind Through the Keyhole"
subtitle: "What a Distillation Attack Actually Is"
date: 2026-06-27 09:00:00 -0700
description: "Everybody has an opinion about the China distillation thing and almost nobody can define it. What distillation actually is, when it crosses into an attack, and the 25,000 fake accounts that prove it."
image: /assets/og/stealing-a-mind-through-the-keyhole.png
tags: [ai-security, model-extraction, distillation]
---

Everybody in the server has an opinion about the China distillation thing and almost nobody can tell you what distillation is. So before the panic, before the geopolitics, before somebody says the word singularity, let us do the unglamorous part and define the term, because the definition is where all the confusion lives.

```
        F R O N T I E R   M O D E L
        ===========================
          a big, expensive mind
          a whole apparatus of
          refusals and brakes
        ===========================
                    |
                    |   25,000 fake accounts
                    |   29,000,000 queries
                    v
                 .-----.
                  \   /      the keyhole
                   \ /       ( a paid API )
                    v
                 cheap clone
                 ~~~~~~~~~~~
                  sharp edges, no brakes
                                      蒸  馏
```

## 0x01 · The thing itself

Distillation is old and boring and completely legitimate. You take a big, expensive, smart model. You ask it a mountain of questions. You write down the answers. Then you train a smaller, cheaper model to imitate those answers. The little model never sees how the big model thinks. It only sees what the big model says, and it learns to say the same kind of thing.

That is it. A student copying a tutor's answers until the student can fake the tutor. Frontier labs do this to themselves on purpose all day long, it is how you get a small fast cheap model that behaves almost like the giant one. The technique is not the crime. Remember that, because the headlines will try to make you forget it.

The crime is in the how, the where, and the whose.

## 0x02 · When a tool becomes an attack

It becomes a distillation attack, also called model extraction, when three things stack up at once.

One, scale. Not a person poking a chatbot, a machine firing millions of carefully shaped queries designed to map the target model's behavior across every domain you care about.

Two, theft of access. The target told you no. You are geofenced out, or banned by terms of service, or both. So you launder your way in through fake accounts and resale proxies and pretend to be thousands of innocent users.

Three, intent. You are not asking because you want answers. You are asking because you want the answers as training data, to build a competitor that approximates the original at a fraction of the cost and time it took to make it.

Strip it down and a distillation attack is industrial espionage where the thing being stolen is not a document or a blueprint. It is the behavior of a mind, copied one query at a time through the keyhole the vendor left open for paying customers.

## 0x03 · The receipts

This is not theoretical and the numbers did not come from a forum. They came in a letter to US senators.

Operators tied to a very large Chinese conglomerate's AI lab stood up roughly twenty five thousand fraudulent accounts and ran close to twenty nine million exchanges against a leading American model across about six weeks this spring, April into June. The queries were aimed at the expensive parts, software engineering and agentic reasoning, the capabilities that actually cost a fortune to build. The vendor called it the largest extraction campaign it had ever caught.

And it was not the first. A disclosure earlier in the year named three other labs that had collectively burned through some sixteen million exchanges across about twenty four thousand fake accounts. The detail that should make your skin crawl: when the vendor shipped a brand new model mid campaign, one of those operators pivoted within a single day and redirected nearly half its traffic to go scrape the fresh capability before anyone could blink. That is not an accident or a curious researcher. That is an operation with a sprint board and an on call rotation.

Underneath all of it sits a grey market. Resellers move stolen API access at ninety percent off, swap one model's responses in for another, and harvest the prompts and outputs of their own paying customers to turn around and sell as training data. Theft at retail and theft at wholesale, vertically integrated, with a storefront.

## 0x04 · How they actually do it

The playbook is dull and effective, which is the worst combination.

Because the target does not sell to the region, the operators route through commercial proxy services that resell frontier access at scale. They spin up thousands of accounts so no single one trips a volume alarm. They shape the prompts to cover a capability surface methodically, the way you would map a network, not the way a human stumbles through a chatbot. The traffic looks wrong if you can see all of it at once: the volume, the structure, the relentless focus on the same high value skills. It looks like a sweep, because it is one. The only reason the vendor caught it is that the vendor could see the whole shape from the inside. From the outside it is twenty five thousand strangers asking ordinary questions.

## 0x05 · The part that should scare you

Here is the proliferation fact that the panic posts miss entirely.

When you clone a model off its outputs, the dangerous parts copy cleanly. The exploit hunting, the lateral reasoning, the tireless enumeration, all of that photocopies beautifully because it shows up directly in the answers you are harvesting. The safety does not. The refusals, the guardrails, the alignment, the whole expensive apparatus built to keep the thing from helping a bad actor, that is the first thing that smears in the duplication, because you were never harvesting the refusals. You were routing around them.

So you do not end up with a slightly worse copy of the original. You end up with the sharp edges and none of the brakes, produced for pennies, in the hands of whoever could afford a botnet. The careful part is hard and slow and expensive. The reckless part is cheap and fast. Guess which one scales.

## 0x06 · Why governments lost their minds

The framing from the bleeding vendor is blunt and basically correct: this turns billions of dollars of someone else's research and development into a free subsidy for a strategic rival. You spend years and a fortune building a frontier capability, and a competitor approximates it in weeks by drinking your exhaust.

It also rewires the export control argument in a way worth understanding. When a rival lab suddenly leaps forward, the lazy read is that chip controls failed, that innovation routed around them. The distillation evidence says something else: a chunk of that leap was not independent innovation, it was capability siphoned out of an American model, and pulling that off at scale still needs advanced chips to run the extraction and the training. So the theft does not prove the controls are pointless. It is part of the argument for them. The policy machine noticed. There are memos, there are proposed amendments to must pass defense bills, there is talk of penalties for labs that extract. The fight left the courtroom and walked into the national security wing.

## 0x07 · The honest caveat

Do not let the war drums rewrite the definition. Distillation is a normal, legitimate, widely used training method. The math is not evil. A small model learning from a big one is how half the cheap fast models you actually use got made.

What makes this an attack is not the technique. It is the twenty five thousand fake accounts, the geofence you tunneled under, the terms of service you shredded, and the intent to clone a competitor you were told you could not have. Same tool, different ethics, and the entire story lives in that gap. Anybody who tells you distillation is theft is wrong. Anybody who tells you this particular distillation was not theft is also wrong. Hold both.

## 0x08 · Outro

```
the mind got copied through the keyhole and the keyhole was a paid API.
the capability came across clean. the conscience did not.
patch your terms of service. log your traffic. wear black.

                                                            EOF
```
