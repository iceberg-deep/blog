---
layout: post
title: "The Key Was Already on the Keyring"
subtitle: "HTB Access, where anonymous FTP leaks an old backup, a chain of stale passwords walks you to a telnet shell, and Windows hands you the admin password it promised to keep secret"
date: 2019-03-02 12:00:00 +0000
description: "Anonymous FTP leaks a backup, a chain of stale passwords leads to a telnet shell, and Windows coughs up the admin password it swore to protect."
image: /assets/og/the-key-was-already-on-the-keyring.png
tags: [hackthebox, writeup]
---

Access is a building-security company, and the joke writes itself, because the building leaves its own door propped open. There is no exploit on this box in the usual sense. No memory corruption, no clever overflow, no CVE you can point to. There is an FTP server that lets a stranger in with no password, an old database backup sitting in the share, a chain of reused credentials that each unlock the next, and a Windows feature that politely stores the administrator's password and then hands it to anyone who knows how to ask. You do not break Access. You follow a trail of keys somebody left out, and the last key was on the keyring the whole time.

```
        A C C E S S   C O N T R O L
        ===========================
        ftp (anon)  →  backup.mdb  +  Access Control.zip
                              |
        mdb table  →  engineer : access4u@security
        that pass opens the zip  →  a .pst email file
        the email  →  security : 4Cc3ssC0ntr0ller   (telnet in)
                              |
                              v
        a shortcut on the desktop says
        "run me as Administrator, password saved."
        windows kept that password. you just ask for it back.
                                            鍵
```

## 0x01 · the lobby

Three ports answer, and the shape of them tells you this box is older and stranger than most Windows targets.

```
PORT   STATE SERVICE
21/tcp open  ftp
23/tcp open  telnet
80/tcp open  http
```

No SMB. No 445, no RPC, none of the usual Windows furniture. Instead you get FTP and telnet, two protocols that send everything in plaintext and that most shops turned off a decade ago. Port 80 serves a single static page for "LON-MC6," a wall of security-camera thumbnails with no real app behind it. The web page is set dressing. The two old protocols are the box, and the fact that they are running at all is the first confession. This is a machine configured by someone who reached for the tools they already knew, not the ones that were safe.

## 0x02 · the unlocked filing cabinet

FTP allows anonymous login, which means you type `anonymous` as the username, press enter on the password, and you are inside.

```
# ftp 10.10.10.98
Name: anonymous
Password:
230 User logged in.
ftp> ls
Backups
Engineer
```

Two folders, and both have something in them. `Backups` holds `backup.mdb`, a Microsoft Access database, about five and a half megabytes. `Engineer` holds `Access Control.zip`. Pull both down, and remember to flip FTP into binary mode first with `binary`, or the files arrive corrupted, mangled by the ancient ASCII-translation habit FTP still carries.

Anonymous FTP is the unlocked filing cabinet in the lobby. Picture an office where the front desk drawer is left open and labeled "old backups, do not touch." Nobody is guarding it, the label is the only lock, and the label does not actually lock anything. Everything that follows pours out of that one open drawer.

## 0x03 · the database that kept the password

`backup.mdb` is an Access database, and you do not need Microsoft Access to read one. The `mdbtools` suite on Linux opens these files happily. First list the tables, then dump the interesting one.

```
# mdb-tables backup.mdb
... auth_user ... acc_login ... (dozens of tables) ...

# mdb-export backup.mdb auth_user
id,username,password,...
25,"admin","admin",...
27,"engineer","access4u@security",...
```

A table literally named `auth_user`, holding usernames and passwords in the clear. The one that matters is `engineer : access4u@security`. A database backup is a snapshot of everything an app knew at one moment, and "everything it knew" included the login credentials, stored as plain text. Think of it like photographing your whole desk to remember where things were, then leaving the photo on the bus. Every sticky note with a password on it is now in the picture, perfectly readable, for whoever finds the photo.

## 0x04 · one key opens the next lock

That zip from the `Engineer` folder is encrypted. Try the password you just pulled from the database, because the first rule of these boxes, and of real networks, is that people reuse passwords across everything.

The catch is the compression. A plain `unzip` chokes here with "unsupported compression method 99," which is the marker for an old WinZip AES scheme that `unzip` never learned. Reach for `7z` instead, which speaks it fine.

```
# 7z x "Access Control.zip"
Enter password: access4u@security
Extracting  Access Control.pst
```

The engineer's password opened the engineer's zip. One key, the next lock, exactly as the password-reuse habit promises. Inside is a single file, `Access Control.pst`, an Outlook personal-folders file. A `.pst` is just a mailbox frozen into one file, the entire contents of someone's Outlook account in a box you can carry off.

## 0x05 · the email that changed the password

You read a `.pst` on Linux with `readpst`, which converts it into the older mbox format that every mail tool understands. Then open the result.

```
# readpst "Access Control.pst"
# mutt -Rf "Access Control.mbox"
```

One message sits inside, from "John Doe" to the security account, and it is the kind of email security teams have nightmares about.

```
From: john@megacorp.com
Subject: MegaCorp Access Control System "security" account

the password for the "security" account has been changed
to 4Cc3ssC0ntr0ller. Please ensure this is passed on ...
```

A password rotation announced in plaintext email, then backed up, then zipped with a password that was sitting in a database backup, then left on an anonymous FTP share. Every link in that chain was someone trying to be helpful. The result is that you now hold `security : 4Cc3ssC0ntr0ller`, and telnet is open.

```
# telnet 10.10.10.98
login: security
password: 4Cc3ssC0ntr0ller

C:\Users\security> type Desktop\user.txt
████████████████████████████████
```

Telnet is the ssh of the bad old days, a remote shell with no encryption at all. The box handing it to you is fitting, because nothing on Access has been encrypted in any way that mattered. The whole trail was readable to anyone standing in the lobby.

## 0x06 · the shortcut that names the admin

The `security` user is not an administrator. But sitting on the shared desktop is a clue so loud it is almost a note left for you. Look at `C:\Users\Public\Desktop`, and there is a shortcut, `ZKAccess3.5 Security System.lnk`. Read where it points.

```
C:\> type "C:\Users\Public\Desktop\ZKAccess3.5 Security System.lnk"
... runas.exe /user:ACCESS\Administrator /savecred
    "C:\ZKTeco\ZKAccess3.5\Access.exe" ...
```

That is the whole privilege escalation, written out in advance. Whoever set up this kiosk wanted the security software to launch with admin rights without anyone typing a password every time, so they used `runas /savecred`. The `/savecred` flag tells Windows: ask for the administrator password once, then remember it forever and reuse it silently. Confirm it is still cached.

```
C:\> cmdkey /list
    Target: Domain:interactive=ACCESS\Administrator
    Type: Domain Password
    User: ACCESS\Administrator
```

There it is, the administrator's credential, stored on the box, tied to your low-privilege `security` session. Picture a valet who is sick of you handing him your car key, so he stamps a copy and keeps it in his pocket "for convenience." Anyone who can reach into that pocket now drives your car. The convenience and the vulnerability are the same object.

## 0x07 · asking windows for the key back, twice

The lazy way uses the cached credential directly. Because `/savecred` already stored the password, you can run anything as the administrator without ever knowing what that password is. You just borrow the saved key.

```
C:\> runas /user:ACCESS\Administrator /savecred "[ a command run as admin: drop iceberg payload ]"
```

Point that at a payload of your choosing, catch the result, and you are running as `ACCESS\Administrator`. Clean, but it leaves you slightly unsatisfied, because you got a shell without ever seeing the actual password. So take the more honest road and pry the real plaintext out of where Windows hid it.

That hiding place is DPAPI, the Data Protection API. When `cmdkey` "saves" a credential, Windows does not store it in the clear. It encrypts the credential blob with a master key, and it encrypts that master key with a key derived from the user's own login password. Think of it like a safe-deposit box. The credential is the document inside the box, the master key is the box key, and your login password is what the bank checks before handing you that box key. You already know the `security` login password, `4Cc3ssC0ntr0ller`, so you can walk the whole chain.

Two files matter. The encrypted master key lives under the user's profile, named by the user's SID, and the encrypted credential blob sits beside it.

```
C:\Users\security\AppData\Roaming\Microsoft\Protect\
    S-1-5-21-953262931-566350628-63446256-1001\0792c32e-48a5-4fe3-8b43-d93d64590580
C:\Users\security\AppData\Roaming\Microsoft\Credentials\
    51AB168BE4BDB3A603DADE4F8CA81290
```

Base64 them off the box with `certutil -encode`, bring them home, and let `mimikatz` do the unlocking. First feed it the master-key file along with the SID and the login password to unwrap the master key, then feed it the credential blob.

```
mimikatz # dpapi::masterkey /in:0792c32e-... /sid:S-1-5-21-953262931-566350628-63446256-1001 /password:4Cc3ssC0ntr0ller
  ... key : b5d2c... (master key recovered)

mimikatz # dpapi::cred /in:51AB168BE4BDB3A603DADE4F8CA81290
  ...
  CredentialBlob : 55Acc3ssS3cur1ty@megacorp
```

There is the administrator's real password, in the clear, `55Acc3ssS3cur1ty@megacorp`. The safe-deposit box opened because you had the one thing the bank checks, the login password, and DPAPI never pretended otherwise. From there it is a plain login.

```
C:\Users\Administrator> type Desktop\root.txt
████████████████████████████████
```

## 0x08 · the honest caveat

It is easy to read Access as a museum piece. Anonymous FTP, plaintext telnet, an Access database backup, who runs any of that in 2026? But the bug class on display is not a fossil, and that is the part worth keeping. Nothing here was an unpatched flaw. Every single step was a feature working exactly as designed, used by someone who was trying to make their life easier.

`/savecred` is the heart of it. It exists because typing a password every time is annoying, and the fix for that annoyance is to let the operating system hold the password for you. DPAPI is genuinely good cryptography. It did not leak the credential to a network attacker, it did not store it in the clear, it tied the secret to the user's own password exactly as the design intended. And that was the whole problem, because once an attacker owns the user, owning the user's password owns everything that password was protecting. The encryption did its job perfectly and still handed over the keys, because the lock and the person who opens it had become the same thing.

The deeper lesson stacks underneath. A secret is only as safe as the worst place it is ever written down. The administrator password on Access was strong, long, full of substitutions, the kind a brute-forcer would chew on for years. It did not matter, because the box never had to be cracked. The password walked out through a saved credential, and the road to that credential was paved with a database backup nobody encrypted, a zip whose password sat in that backup, and an email announcing a password change in plaintext. Strong locks on a chain of open doors protect nothing. The attacker just uses the doors.

## 0x09 · outro

```
nobody picked a lock on this box.
every door was already open, and every key was already cut.

the backup remembered the password. the zip reused it.
the email announced the next one. and windows, helpfully,
kept the admin's key in its pocket and handed it over on request.

strong passwords die in weak hands. encrypt the backup. kill the saved cred.
wear black.

                                                            EOF
```

---

*HTB: Access, retired 2 Mar 2019. An easy Windows box with no exploit at all, just a trail of stale credentials ending in a password Windows promised to keep. The keyring was the vulnerability.*