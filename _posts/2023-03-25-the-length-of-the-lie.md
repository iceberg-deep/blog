---
layout: post
title: "The Length of the Lie"
subtitle: "HTB Extension, where a leaked table, a guessable reset token, a browser plugin that trusts an issue, and a hash you can grow past its own seal stack into a docker breakout"
date: 2023-03-25 12:00:00 +0000
description: "Extension is a five-link chain where every link is somebody trusting input they never measured, ending in a hash you can grow past its own seal and a docker socket that hands over the host."
image: /assets/og/the-length-of-the-lie.png
tags: [hackthebox, writeup]
---

Extension is a long con, and that is the joke buried in the name. It is not one bug, it is five small acts of misplaced trust shaken hands in a line, and every single one is a thing that trusted input it never bothered to measure. A dump endpoint hands you the password table without asking who you are. A reset token that is mostly a name spray your way to an account. A browser plugin meant to preview a help ticket runs the ticket instead. A signature you can grow longer than the secret that signed it. And at the bottom, a socket that quietly is the whole machine. None of it is a memory-corruption magic trick. Each link is somebody who looked at the front of a thing and never checked the length of it.

```
        E X T E N S I O N
        =================
        /management/dump   "the whole users table? sure."
                |
        reset token  =  md5(name) + 3 random digits
                |        spray hundreds, then guess
                v
        a plugin previews your issue. it runs your issue.
                |
        a signature you can keep typing past the secret
                |
                v
        a socket in the box that IS the box.
                                            印
```

## 0x01 · the doormat

`nmap` is almost rude in how little it shows. Two ports, and one of them is the way you knock everywhere.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 7.6p1 Ubuntu 4ubuntu0.7
80/tcp open  http    nginx 1.14.0 (Ubuntu)
```

The headers on port 80 whisper PHP 7.4 and a Laravel session cookie, so this is a framework app, not a hand-rolled site. Point a vhost fuzzer at the Host header and the single building turns into a street. Three names answer: `snippet.htb`, the Laravel app itself, `mail.snippet.htb` running RoundCube, and `dev.snippet.htb` running Gitea. Think of it like knocking on one door and learning the whole block shares a landlord. The mail server and the git server matter, because the foothold is going to bounce between all three.

## 0x02 · the table left on the counter

Dig through the app's JavaScript and the routes spill out, including one that has no business being reachable: `/management/dump`. It takes a POST, a Laravel CSRF token, and a JSON body naming a database table, and it just hands the table back. No login. No role check. You ask for `users`, you get `users`.

```
$ curl -s http://snippet.htb/management/dump \
    -H "Content-Type: application/json" \
    -H "X-XSRF-TOKEN: <token>" \
    -b "XSRF-TOKEN=<token>; snippethtb_session=<session>" \
    -d '{"download":"users"}'
```

Out comes the full roster, hundreds of accounts, each with a SHA-256 password hash. SHA-256 with no salt is hashcat mode 1400, and a wordlist eats it for breakfast.

```
$ hashcat -m 1400 hashes rockyou.txt
ef92b778bafe771e89245b89ecbc08a44a4e166c06659911881f383d4473e94f:password123
```

Four separate users picked `password123`, which is its own quiet lesson about people. Those creds log into the website and, because the same humans reuse the same word, into their RoundCube mailboxes too. Picture a building manager who keeps every tenant's mailbox key on a board in the unlocked lobby. The lock on each box still works fine. It was never the lock that failed.

## 0x03 · a token that is mostly a name

You are inside now, but as nobodies. An IDOR walk through `/snippets/{id}` points at the user who actually matters, Jean, who holds the keys to Gitea. To become Jean you abuse the password reset, and this is the prettiest bug on the box.

Trigger a reset and read the link out of the mailbox you already own. The token looks random until you stare at it. The first thirty-two characters are exactly `md5(email)`, a value you can compute yourself in a heartbeat. Only the last three digits are random. So the token is not a secret, it is a name with a three-digit padlock bolted on.

```
token = md5("jean@snippet.htb") + NNN
      = 485e80367de25d57b07aa692feeedf8f + 224
```

Brute-forcing one token against a thousand guesses is loud and the app will throttle you. So you flip the math. Every time you request a reset, the server mints a *new* valid token and keeps it alive. Fire hundreds of reset requests and you now have hundreds of live tokens sitting in the lock at once. Now a handful of guesses lands on one of them.

```
$ for i in $(seq 1 500); do
    curl -s http://snippet.htb/forgot-password \
      -H 'Content-Type: application/json' \
      -d '{"email":"jean@snippet.htb"}'
  done
```

Think of it like a combination lock with a thousand settings. Guessing one number is a long shot. But if you can jam five hundred correct combinations into the mechanism at the same time, almost any number you try slides one of them open. You did not get better at guessing. You changed how many right answers were waiting.

## 0x04 · the plugin that read the ticket aloud

Jean's account hands over Gitea, and Gitea hands over the strangest piece of this box, a custom browser extension. Its honest job is small and friendly. On any page whose URL ends in `/issues`, it reaches into each issue, grabs the body text, and previews it inline so you can skim tickets without clicking in.

To preview text safely you must scrub it, and the extension's `check()` function tries. It strips HTML tags and blocks a list of dangerous characters, parentheses, quotes, semicolons, the words `src` and `script`. It is trying to be a bouncer. It just cannot count and cannot read.

Two flaws, both about length and case. The tag stripper runs its regex once, so it removes the *first* tag and leaves every tag after it standing. And the keyword filter is case-sensitive while HTML is not, so `script` is forbidden but `Script` walks right in. Picture a bouncer with a banned-names list written in lowercase who only ever checks the first guest in any group. Walk in second, capitalize your name, and you are inside.

So you file an issue whose body is a payload that survives the scrub, built without the banned characters and wearing the wrong case on purpose.

```
[ stored XSS in an issue body: an <img> with a capitalized
  SRC and an onerror that base64-decodes and runs JS, dodging
  the single-pass tag strip and the case-sensitive keyword filter ]
```

When anyone with the extension views the issues list, their browser previews your ticket and runs your code as them. You aim it at the Gitea API and pull down a private repository called `backups` that belongs to a user named charlie. The plugin meant to *read* the ticket *ran* the ticket, which is the entire definition of cross-site scripting in one sentence.

Inside the backup is an SSH private key, and the key is for charlie. The filename was the username, the way it so often is.

```
$ ssh -i charlie_id_rsa charlie@10.10.11.171
charlie@extension:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the signature you can keep typing

Charlie can see the web app's internals now, and there is a signed request in there. The server signs a parameter by hashing a secret concatenated with your data, `MAC = hash(secret || data)`, and trusts any request whose tag matches. That construction looks sound and is quietly broken, because of how these hashes are built.

A hash like MD5 or SHA-256 does not digest a message all at once. It chews it block by block, carrying its running state forward, and the final state *is* the signature it prints. Which means if you know the signature, you know exactly where the machine stopped, and you can sit down and keep typing from there. You append your own data, finish the hashing, and produce a valid signature for a message you were never supposed to be able to sign, all without ever learning the secret. This is a hash length extension attack, and the tool `hash-extender` does the bookkeeping.

```
$ hash-extender --data 'orig' --secret 32 \
    --append ';your-injected-payload' \
    --signature <known-mac> --format sha256
```

Think of it like a sealed letter where the wax stamp is just a running tally of every word so far. You cannot read the secret words at the top, but the seal told you the tally, so you can pick up the pen, write three more sentences at the bottom, update the tally, and press a seal that looks perfectly genuine. You never forged the stamp. You just kept writing past where the writer stopped.

The data you append lands in a spot the app feeds to a shell, so the forged signature carries a command injection. That gives you remote code execution, and the shell that comes back is not the host.

```
www-data@webapp-container:/$ ls -la /var/run/docker.sock
srw-rw---- 1 root docker 0 ... /var/run/docker.sock
```

## 0x06 · the socket that was the whole house

That last line ends the box. A reverse shell out of the injection lands you inside the website's docker container, and sitting in the container is `/var/run/docker.sock`, the control channel for the docker daemon, and you can write to it.

Here is the thing people forget. The docker daemon runs as root on the *host*, not in the container. The socket is a remote control for that daemon. So if you can talk to the socket, you can tell host-level root to do anything, including start a brand-new container that mounts the host's entire filesystem inside itself and hands you a shell as root over all of it.

```
$ docker -H unix:///var/run/docker.sock run -it -v /:/host alpine \
    chroot /host sh
# id
uid=0(root) gid=0(root)
# cat /root/root.txt
████████████████████████████████
```

Picture a hotel room with a phone on the nightstand that dials straight to the building's master-key office, no questions asked. You are locked in your one room, sure. But the phone does not care which room you are in. Ask the office to send up a master key and it sends a master key. The container was the locked room. The socket was the open line.

## 0x07 · the honest caveat

Pull back and every link in this chain is the same confession told five ways: someone trusted the front of an input and never measured the rest of it. The dump endpoint trusted that whoever asked for the users table was allowed to. The reset token trusted that a name plus three digits was unguessable, and forgot you could stack five hundred right answers into the lock at once. The extension trusted that scrubbing the first tag scrubbed them all, and that lowercase was the only case. The signature trusted that knowing the tag did not let you keep typing past the secret. And the socket trusted that being inside a container meant being contained.

The hash extension step is the one worth tattooing somewhere, because it is the least intuitive and the most permanent. `hash(secret || data)` *feels* like a signature. It looks like one in a code review. It passes tests. And it is fundamentally forgeable, because the family of hashes underneath it was built to be continued, not to be sealed. The fix is not a longer secret or a fancier hash. The fix is HMAC, a construction designed from the start so that knowing the output tells you nothing about how to extend it. The lesson is not "MD5 is old." The lesson is that you cannot bolt a seal onto a tool built for appending and call it security.

And the docker socket is the privesc I would actually lose sleep over, because nothing was unpatched. No CVE, no exploit, no missing update. An engineer mounted the socket into a container for convenience, the way you would leave a useful tool within reach, and that convenience is a direct wire from any code in the container to root on the host. You cannot patch your way out of a design decision. Only a second look at the architecture fixes that one.

## 0x08 · outro

```
the table was on the counter, so you took it.
the lock was a name in a costume, so you stacked the answers.
the plugin read your ticket out loud, exactly as written.
the seal told you where to keep writing, so you wrote.
and the locked room had a phone to the master-key office.

five doors, none of them forced. each one measured wrong.
the only secret on the whole box was a length nobody checked.

measure the input. seal with hmac. mind the socket. wear black.

                                                            EOF
```

---

*HTB: Extension, retired 18 Mar 2023. A hard Linux box that is really a lecture on measuring your inputs, where a hash length extension wears a valid signature like a borrowed coat and a docker socket quietly is the whole machine. Every link held open from the inside.*