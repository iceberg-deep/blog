---
layout: post
title: "Pass It Sideways."
subtitle: "A Red Team Story, and the Encrypted Whisper That Carried the Secret Home."
date: 2026-06-28 16:30:00 -0700
description: "On a sanctioned red team job the phone was the only tool in the room, and the secret had to cross the open internet without touching the client's network or some random cloud. Here's the whole chain, and the encrypted relay that closed it."
image: /assets/og/pass-it-sideways.png
tags: [red-team, opsec, lateral-p455]
---

Picture the worst possible moment to need a clipboard. You're standing in a server closet you talked your way into, wearing a safety vest and a badge with a company name that doesn't pay you. On the screen in front of you is the one piece of text that ends the whole job early. You've got maybe ninety seconds. You can't plug anything in, because the ports are alarmed and the contract you signed says hands off. The office WiFi is watched. Every normal messaging app is blocked, and even if it wasn't, dumping a client's secret into some random company's cloud is the kind of move that ends a contract and starts a lawsuit. The secret is right there on the glass. And you have no clean way to carry it out of the room.

```
        P A S S   I T   S I D E W A Y S
        ===========================================
          [ PHONE ]  >enc>  [ EDGE ]  >enc>  [ LAPTOP ]
             |              dumb mailbox            |
        scramble here    sees  > salt iv ct    unscramble here
        key never leaves reads > nothing        same password
        ===========================================
          the server is a courier
          who can't open the envelope
                                          横
```

So pour yourself something dark, because this is a story about the least glamorous problem in hacking ... moving one piece of text from one of your devices to another ... and the tiny encrypted tool that solved it without leaving a mess anywhere it shouldn't.

## the engagement

Names changed, but the shape is real. Call the client Meridian, a medium sized payments company, the kind with real money sitting behind a tired old fence. The contract was the fun kind. They didn't want the easy test, they wanted the whole movie. Breaking in physically was allowed. Talking my way in was allowed. The goal ... reach the internal money console and prove I got there, by a deadline, with a signed permission letter folded in my back pocket the entire time. That letter is the only thing standing between penetration tester and burglar.

**Recon.** Weeks before I set foot anywhere, it was all public information. Job posts that quietly name the software a company runs. A maintenance guy tagged in a lobby photo, badge dangling, lanyard a very specific shade of orange. Delivery times. LinkedIn telling me who just got hired and was still too new to question a stranger. None of it touched Meridian's network. All of it built the costume. It's like studying for a test by reading everything around the textbook instead of the textbook.

**The pretext.** New hire week is a gift. Everyone is a stranger that week, so one more stranger blends right in. I showed up as an air conditioning subcontractor for a company I knew they actually used, holding a work order that named a real system in their building. The trick is never the lie by itself. It's the true thing you wrap around the lie so it feels normal.

**Entry.** Tailgating is just politeness turned into a weapon. You walk up with your hands full at the exact second someone badges through the door, and the same instinct that makes us hold doors for each other holds the door for me. I was on the secure floor in under a minute. Nobody's security plan ever accounts for good manners.

**The foothold.** I didn't need some genius hack. I needed thirty seconds alone and the simple fact that people write down what they can't remember. A computer left unlocked over lunch. A powerful password on a sticky note, because the rule that forces you to keep changing passwords had finally outrun what a human brain can hold. And on the screen, half finished, a setup page for a second login code ... a QR code, live, waiting to link a new phone. That QR code was the whole game. Link it to a device I controlled, and the money console's extra security was suddenly mine too.

And here was the catch hiding inside the win. The device I controlled was my laptop, sitting in a rented car in the parking garage four floors down. The QR code was up here, on a monitor I couldn't unplug, couldn't photograph into any app the network would allow, and couldn't copy onto their WiFi without setting off the exact alarms I was being paid to test. The key was in one room. The lock it opened was in another. That little gap, six inches of glass and four floors of concrete, is where most of these jobs quietly fall apart.

**The lateral pass.** I had my own phone. Not the client's, and not on their WiFi ... on my own cell signal, my problem and nobody else's. On it was a little web app I host on my own account. I snapped a photo of the QR code, and the moment it left my phone it was already scrambled. What landed on my own server was a locked box the server itself could not open. Four floors down, the laptop in the car was already checking that same little mailbox using the same password. It grabbed the box, unlocked it in the browser, and the QR code popped back onto a screen I owned. We linked the device. The client's secret never sat out in the open anywhere except two browsers I controlled, and it never crossed a network that wasn't mine. It was basically AirDropping a photo to myself, except the photo was written in a language only my two devices could read.

**The objective.** The rest was boring, the way good operations are supposed to be. Linked second code, the password off the sticky note, a session into the money console, a screenshot of a balance screen no air conditioning guy should ever see, and a harmless marker file dropped in to prove I could write there too. Then I walked out the way I came in, holding the door for somebody, because manners get you out as easily as they get you in.

The finding that mattered to Meridian was the sticky note and the unlocked screen. The finding that mattered to me was quieter. The whole chain had one weak hinge, the handoff between my two devices, and it held because the tool sitting on that hinge was built to leak nothing.

## 0x01 · the thing itself

That tool is Lateral P455. The name is a play on a lateral pass, tossing the ball sideways to a teammate, and P455 spells PASS if you squint. It's a tiny web app that runs on Cloudflare, just static files and a few small functions, and you can host the whole thing yourself in a couple of minutes. It's a clipboard that works across your own devices, phone to laptop and back, where the server only ever holds scrambled text it can't read.

You type on one device and it shows up on the other. You share a photo from your phone and grab it on your laptop. That's the whole surface. The clever part is everything it refuses to know.

## 0x02 · the use cases

It earned its spot in that car, but it lives in the boring days too. Where it comes in clutch →

✓ The field phone handoff. Exactly the story above. Something you grab on the one device allowed in the room, carried over to the device that can actually use it, on a channel you fully control.
✓ A cross device clipboard that isn't anybody else's business. The everyday one. Move a long password or a link from laptop to phone without emailing it to yourself and handing it to a mail company forever.
✓ Files and photos with the name hidden. Up to 25 MB, scrambled in your browser, and even the file's name is kept secret from the server.
✓ Burn after reading. Set a message to delete itself the second the other device opens it. Like a Snap. One look, then gone.
✓ Your own notes, off the client's turf. On a job, a place to stash a string that is provably not in your work chat, not in your personal email, and not sitting in some company's cloud.

The rule that keeps all of this clean is the same rule that kept the job legal. These are your devices and your allowed material, moving between two browsers you own. The tool is a delivery driver, not a crowbar. What you hand it is on you.

## 0x03 · how it's secure

This is the part that let me actually sleep afterward. All of it uses the browser's own built in crypto, so there is nothing fancy bolted on the side to break.

✓ The server is a dumb mailbox. It checks who you are so you only see your own stuff, and then it just holds sealed boxes. It never has your password and can't read a thing. That isn't a promise buried in a privacy policy. It's literally the only data it ever gets handed. Picture a mail carrier who delivers a sealed envelope. They carry it. They can't open it.
✓ The password is the secret handshake. Your password never leaves your device. The app stretches it into a key using a slow, deliberately expensive process, hundreds of thousands of rounds, so guessing it is painfully slow. Both devices use the same password, so they understand each other. Type the wrong one and you just get a lock icon and gibberish, which is exactly what should happen.
✓ The lock itself is AES 256, the same kind of scrambling banks and governments lean on. Every message gets its own fresh random starter value, and the lock also checks for tampering. Flip a single letter in transit and it refuses to open instead of quietly lying to you.
✓ Three doors, and the inner one is always locked. Door one is a secret link that blocks everyone until a device unlocks once. Door two is a real company login at the edge, for teams. Door three is the end to end password, always on, so even a fully logged in server still only holds sealed boxes.
✓ Even link previews stay sealed. When you send a link, the little preview gets bundled inside the scrambled message, so the server forgets it right away. The thing that fetches previews is also fenced off, so it can't be tricked into poking around the inside of a network.
✓ Nothing lingers. Every item has an expiration. Delete after reading, an hour, a day, a week at most, then it's purged. That closet QR code existed for exactly one unlock, and then it was gone.

Put it all together. In that parking garage, the worst thing anyone watching the network between my phone and my server could have written down was that a sealed box of some size existed at some time. Not the QR code. Not the secret. Not even the file name. The envelope, never the letter.

## 0x04 · the honest caveat

Because this is still the honest blog, the tool's own weak spots get a turn.

Lateral P455 is a clipboard for your own devices, not a bunker grade messenger. It has no forward secrecy, which is a fancy way of saying every message under one password shares the same lock. So if someone records your scrambled traffic today and steals your password a year from now, they can go back and open the old stuff. For truly high stakes conversations, the right answer is still Signal, and I'll say that out loud instead of overselling my own toy. The password is everything, and there is no reset. Forget it and your data is just math you can't undo. The secret link is exactly that, a secret. Anyone holding the link can reach the app, though they still can't read a word without the password. And even though the server is blind to your content, it can still see the outside of the envelope ... that a message exists, how big it is, and when it showed up.

So hold both ideas. Scrambling hides what you said. It doesn't always hide that you said something. On that job the outside of the envelope meant nothing and the contents meant everything, so the trade was perfect. Pick a different fight and the math changes. Know which fight you're in before you trust any tool, mine included.

It's free and open, MIT licensed, and you host the whole thing on your own account, which is the only setup I'd trust with anything that matters. Don't trust someone else's copy. Run your own mailbox, and be the only person who can't read it.

## 0x05 · outro

```
the key was in one room. the lock was in another.
the gap was six inches of glass and four floors of concrete.
the pass went sideways, sealed, and landed in a browser nobody else owned.

the server carried the envelope and never read the letter.
it can still see the envelope, so plan for that.

host your own mailbox. burn what shouldn't stick around. wear black.

                                                            EOF
```
