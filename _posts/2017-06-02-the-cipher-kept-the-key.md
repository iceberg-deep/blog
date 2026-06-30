---
layout: post
title: "The Cipher Kept the Key"
subtitle: "HTB Brainfuck, where every door is locked with a different cipher and the key to each one is hidden inside the last"
date: 2017-06-02 12:00:00 +0000
description: "A WordPress bypass leaks a mail password, a one-time pad reused too long leaks an SSH key URL, and the lxd group hands over the host. Four locks, every key hidden in the lock before it."
image: /assets/og/the-cipher-kept-the-key.png
tags: [hackthebox, writeup]
---

Brainfuck is a box that locks every door with a different cipher and then hides each key inside the door before it. There is no single clever exploit here. There is a chain, and the chain is the lesson. A WordPress plugin lets you become admin without a password, and admin can read the mail settings, and the mail settings hand you a mailbox. The mailbox hands you a login to a secret forum. The forum is written in a cipher, but the person who built the cipher reused his pad until it bled, so the cipher gives up a URL. The URL is an encrypted SSH key, and the key's passphrase is in a wordlist everyone owns. And once you are on the box, the user you became is in a group that can mount the whole disk inside a container he controls. Four locks. Every key was sitting inside the lock that came before it.

```
        B R A I N F U C K
        =================
        wp plugin   →  "log me in as admin"  (no password)
              |
        admin reads the mail config  →  orestis : kHGuERB29DNiNE
              |
        the mailbox holds a forum login
              |
        the forum speaks in cipher, but the pad repeats
              |  the repeat leaks a key, the key leaks a url
              v
        an encrypted id_rsa, a passphrase in rockyou,
        and a user who belongs to the lxd group.
                                            鍵
```

## 0x01 · the certificate that named the rooms

`nmap -sC -sV` comes back with a strange little spread. SSH on 22, a full mail stack on 25, 110, and 143, and HTTPS on 443. No plain HTTP at all.

```
PORT    STATE SERVICE  VERSION
22/tcp  open  ssh      OpenSSH 7.2p2 Ubuntu 4ubuntu2.1
25/tcp  open  smtp     Postfix smtpd
110/tcp open  pop3     Dovecot pop3d
143/tcp open  imap     Dovecot imapd
443/tcp open  ssl/http nginx 1.10.0 (Ubuntu)
```

The mail ports matter later, so hold them. The first real clue is in the TLS certificate, because a certificate has to list every name it is valid for. This one names three rooms in the house: `brainfuck.htb`, `www.brainfuck.htb`, and `sup3rs3cr3t.brainfuck.htb`. Think of a TLS certificate like the directory board in an office lobby. It exists to prove the building is who it says, but it cannot help also listing every tenant by name, including the one whose door has no sign in the hallway. Add all three to your hosts file and you suddenly know about a "super secret" subdomain the box never linked to anywhere. The cert told on it.

## 0x02 · the plugin that forgot to ask

`brainfuck.htb` is a WordPress site. `wpscan` enumerates the installed plugins and one of them is loud: WP Support Plus Responsive Ticket System, version 7.1.3. That exact version carries an authentication bypass, and the bypass is almost insulting in its simplicity.

The plugin has a function meant to log a guest in through Facebook. It calls WordPress's `wp_set_auth_cookie()` to mint a valid session, but it does this *before* confirming you are anyone at all. So you POST a username, any username, and the plugin hands you a logged-in cookie for that account.

```
$ curl -k 'https://brainfuck.htb/wp-admin/admin-ajax.php' \
    --data 'action=loginGuestFacebook&username=admin&email=x'
```

Picture a coat check that issues you a numbered ticket and *then* asks whose coat it is, except it never gets around to asking. You walk up, say "admin," and it stamps a real ticket into your hand. The session cookie that comes back is a genuine admin session. There was no password step to fail, because the code minted the proof of identity before it checked the identity.

Log that cookie into your browser and you are sitting in the WordPress dashboard as `admin`.

## 0x03 · the mailbox the dashboard gave away

Admin on a WordPress site is rarely the prize itself. It is a reading room. The settings pages spill whatever the site needs to do its job, and this site sends mail, so it stores an SMTP password in the mail plugin's configuration. There it is, in plain text in the settings: the account `orestis@brainfuck.htb` and the password `kHGuERB29DNiNE`.

Now those mail ports from the scan come alive. Dovecot is serving IMAP on 143 in the clear. Point any mail client at the box, `orestis` and that password, and read his inbox. I used a console reader, but Evolution or anything that speaks IMAP works the same.

```
$ openssl s_client -connect 10.10.10.17:143    # confirm it answers
$ # then any IMAP client: orestis / kHGuERB29DNiNE on port 143
```

Inside are two messages. One is WordPress noise. The other is the real gift: an admin welcoming `orestis` to a private forum and handing him the credentials for `sup3rs3cr3t.brainfuck.htb`. The same subdomain the certificate let slip in section one. The site password unlocked the mailbox, and the mailbox unlocked the forum.

## 0x04 · the pad that repeated

The secret forum runs on the same login from the email, and inside is a thread that has been encrypted. Every post is a wall of garbled letters, but the *structure* is intact. Each message ends with a signature line, and you can see, post after post, the same encrypted signature in the same place.

That is the crack. The cipher here is a Vigenere, which is just a Caesar shift where the shift changes per letter according to a repeating keyword. Used correctly with a key as long as the message, a one-time pad is genuinely unbreakable. Used incorrectly, with a key that repeats or a fragment of known plaintext, it falls apart. And we have known plaintext. Orestis signs every post `Orestis - Hacking for fun and profit`. Line up that known signature against its encrypted form and the math runs backward to give you the key.

Picture two strips of paper, the plaintext on one and the ciphertext on the other, sliding past each other. If you already know what a stretch of the plaintext says, you can read off exactly how far each letter was pushed, and *that distance is the key itself*. The key recovers to something like `fuckmybrain`. Feed that key back through the rest of the thread and the conversation decrypts into clear English. The decisive line is Orestis being handed a URL to his own SSH key, with the admin adding, "I hope you remember your key password because I dont."

```
https://10.10.10.17/8ba5aa10e915218697d1c658cdee0bb8/orestis/id_rsa
```

A long random folder name guarding the key. Security by "nobody will guess the path." The path was written in a cipher that decoded itself.

## 0x05 · the passphrase everyone already owns

Pull the key down. It is an RSA private key, and it is encrypted.

```
$ curl -k https://10.10.10.17/8ba5aa10e915218697d1c658cdee0bb8/orestis/id_rsa -o id_rsa
$ head -2 id_rsa
-----BEGIN RSA PRIVATE KEY-----
Proc-Type: 4,ENCRYPTED
```

`Proc-Type: 4,ENCRYPTED` means the key file is itself locked behind a passphrase. The admin in the forum said he forgot it, which is the box practically reading you the next instruction. A passphrase a human chose and then forgot is exactly the kind of thing a wordlist holds. Convert the key into a crackable hash with `ssh2john` and let John grind it against rockyou.

```
$ ssh2john id_rsa > id_rsa.hash
$ john --wordlist=/usr/share/wordlists/rockyou.txt id_rsa.hash
3poulakia!       (id_rsa)
```

The passphrase is `3poulakia!`. Think of the encrypted key as a safe and the passphrase as the combination written on a sticky note. We do not have the note, but we have a phone book of every combination a person tends to pick, and this combination was in it. Decrypt the key, fix its permissions, and SSH in as the user named in the path.

```
$ ssh -i id_rsa orestis@10.10.10.17
orestis@brainfuck:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the group that could mount the world

`orestis` is not root, but `id` tells the whole story before you go looking.

```
orestis@brainfuck:~$ id
uid=1000(orestis) ... groups=1000(orestis),110(lxd)
```

The `lxd` group. LXD is the daemon that runs system containers, and membership in that group is effectively root with extra steps, because a container you control can be told to mount the host's own disk inside itself. You do not break out of the container. You invite the host's filesystem in.

Think of it like being handed the keys to the delivery truck and being told you are only allowed to drive it, never to open the warehouse. But the truck has a loading ramp, and the warehouse is just sitting there with its door up. You back the truck against the building, lower the ramp, and now the warehouse floor is part of your truck bed. The container is the truck. The flag `security.privileged=true` lowers the ramp.

Import a tiny image, build a privileged container, and bolt the host's root directory into it.

```
orestis@brainfuck:~$ lxc image import ./alpine.tar.gz --alias icebergimg
orestis@brainfuck:~$ lxc init icebergimg icebergvm -c security.privileged=true
orestis@brainfuck:~$ lxc config device add icebergvm host disk source=/ path=/mnt/r
orestis@brainfuck:~$ lxc start icebergvm
orestis@brainfuck:~$ lxc exec icebergvm /bin/sh
```

Inside the container you are root, and `/mnt/r` is the real host disk. From here root is a formality. You can read the flag straight off the mounted disk, or write yourself a `NOPASSWD` line into the host's sudoers and walk out the front door.

```
~ # cat /mnt/r/root/root.txt
████████████████████████████████
```

There is a second, prettier root path the box leaves open for the cryptographers. A `debug.txt` in root's home gives you the RSA primes `p` and `q` and the public exponent `e` alongside a ciphertext. With both primes in hand the whole of RSA unravels: compute the modulus `n = p*q`, compute `phi = (p-1)*(q-1)`, invert `e` modulo `phi` to get the private exponent `d`, and the ciphertext decrypts to the flag. RSA's entire safety is the bet that nobody can factor `n` back into `p` and `q`. Hand someone the factors directly and you have handed them the private key. Same root, reached with a few lines of Python instead of a container. The box does not mind which you pick.

## 0x07 · the honest caveat

It is tempting to read Brainfuck as a crypto box, and the crypto is the fun part, but the crypto is not where it fails. Every cipher on this machine was, in principle, sound. A one-time pad is unbreakable. RSA is unbreakable. They broke here because of how they were *used*, not what they were. The pad got reused against known plaintext until it leaked its own key. The RSA primes got left in a debug file next to the thing they protected. Strong math wrapped around a careless hand protects nothing, and that is the lesson that outlives the specific tricks.

The deeper thread is that not one link in this chain was a memory-corruption exploit or a zero-day. A plugin minted a session before checking who you were. A password sat in plain text in a settings page. A secret URL was "hidden" behind a folder name that a decoded forum post simply read aloud. A passphrase lived in rockyou. A user sat in a group that quietly equals root. Each one was a default, a convenience, or a shortcut that looked harmless in isolation. The attack is just standing at the end of the hallway and noticing that every door was holding the key to the next. Defenders win this box not by inventing better cryptography but by refusing to leave keys lying next to their locks.

## 0x08 · outro

```
the certificate named a room with no sign.
the plugin opened without asking who you were.
the pad repeated, and a repeat is a confession.
the passphrase was already in everyone's pocket,
and the last user could mount the world.

four locks, and every key was inside the lock before it.
the ciphers were fine. the hands were careless.

decode the door. mind your groups. wear black.

                                                            EOF
```

---

*HTB: Brainfuck, retired 26 May 2017. An insane Linux box that is really a lecture on how perfect ciphers die from careless handling, with an lxd group at the end to remind you that math is never the weakest link.*