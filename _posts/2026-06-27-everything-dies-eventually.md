---
layout: post
title: "Everything Dies Eventually."
subtitle: "Your Encryption Just Has a Date."
date: 2026-06-27
description: "The quantum threat to crypto is real. The doomsday version on your feed isn't. What actually breaks, what survives, and why harvest now decrypt later is the part that should scare you."
image: /assets/og/everything-dies-eventually.png
tags: [post-quantum, cryptography, security]
---

Lets get the melodrama out of the way early so we can be sad together responsibly. Yes the quantum threat to cryptography is real. No it is not the apocalypse your timeline keeps promising you. Its worse in some ways and so much more boring in others, which is honestly the most on brand thing the universe has ever done.

```
            +----------------------+
            |       R . I . P      |
            |                      |
            |   RSA   ECC   DH     |
            |   key exchange and   |
            |   digital signatures |
            |                      |
            |   d. the day a CRQC  |
            |      finally boots   |
        ____|______________________|____
        harvest now  >>>>>>>>  decrypt later

        still standing:  AES 256  .  hashing
```

So pour yourself something dark, put on something from 2004 that your parents hated, and let me walk you through how the lights actually go out.

## What dies first

When a cryptographically relevant quantum computer finally drags itself out of the lab, it does not eat the internet whole. It has a very specific appetite. Shor's algorithm comes for public key cryptography. RSA. elliptic curve. diffie hellman. That is your key exchange and your digital signatures, laid out in the casket, looking peaceful and very much deceased.

Everything else? annoyingly alive. AES 256 strolls out of the funeral completely unbothered. Grover's algorithm shows up to threaten symmetric crypto and basically just halves your effective key length, which means you make the key bigger and go back to staring at the ceiling. Hashing survives. Your bulk encryption survives. The drama is real but its localized, like most tragedies.

## The plot twist nobody screenshots

Heres the part that ruins a good doom post. We already built the replacement.

While everyone was busy being terrified, NIST quietly finalized the post quantum standards back in 2024. ML KEM. ML DSA. SLH DSA. They are already crawling into TLS and your browser and the big cloud providers like ivy through a graveyard fence. This is not a cliff we walk off blindfolded into the void. Its a migration. With a roadmap. With change management tickets. Somehow that is the most depressing sentence in this entire article.

The future does not arrive screaming. it arrives as a deprecation notice.

## The thing that should actually keep you awake

Forget the fireworks. The real horror is quiet and its happening right now while you read this.

Its called harvest now decrypt later. Adversaries are vacuuming up your encrypted traffic today, every handshake, every session, and just. waiting. Patiently. For the machine that does not exist yet. The moment it does, everything they hoarded becomes readable. If your secrets need to stay secret for ten or fifteen years, congratulations, your clock started ticking a while ago and nobody bothered to send you the invitation.

You are not being attacked in the future. you are being recorded in the present. very goth when you think about it.

## About that doomsday date

Lets talk timelines, since everyone loves to pick a year and panic.

No cryptographically relevant quantum computer exists today. The biggest machines are still embarrassingly far from what breaking RSA 2048 actually demands, thousands of error corrected logical qubits running deep circuits without falling apart. Expert consensus lands somewhere around ten to fifteen years, which in this industry is code for "we genuinely do not know."

But heres the unsettling part. The estimated cost to factor RSA 2048 collapsed from roughly twenty million physical qubits a few years ago, down to a million, down to the low hundred thousands, in basically the time it takes to renew a domain. The exact date is fog. The direction is a freight train. Pick your dread accordingly.

## And no, quantum does not make deepfakes

Please for the love of everything, stop welding these two monsters into one. A quantum computer does not forge your video evidence. That is generative AI, an entirely separate creature with its own body count. They are not the same beast wearing different eyeliner.

The answer to fake media is provenance. Content signing. C2PA. cryptographic chains of custody that let a thing prove it is what it claims to be. The answer is not abandoning every digital system and shuffling back to candlelit rooms to sign parchment with a quill like its the year of our lord 1340. We are not doing that. nobody is doing that. put the quill down.

## What you actually do, since you did not ask

- Inventory your cryptography. You cannot migrate what you refuse to look at.
- Get crypto agile. The goal is swapping algorithms without an existential crisis each time.
- Migrate the long lived secrets first. The data that has to survive a decade is the data being harvested tonight.

Thats it. Thats the whole ritual. Deeply unglamorous. The cryptographic equivalent of flossing.

## The closing nobody wants

The sky is not falling. It never is. It just lowers itself slowly while everyone argues about the exact hour.

The machine is coming. Maybe not on the schedule the panic merchants sold you, but its coming, and the people quietly preparing right now get to stand in the wreckage later wearing the insufferable little smirk of someone who read the warning label. And honestly in a field like this that smug survival is about the only reward any of us ever get. Take it. wear the black. migrate your keys.

Everything dies eventually. Your encryption just has a date. Plan around it.
