---
layout: post
title: "The Password Was Printed on the Box"
subtitle: "HTB Mirai, where a Raspberry Pi still wearing its factory login hands you root in two breaths, and the only real fight is pulling a deleted flag back out of a USB stick"
date: 2018-02-17 12:00:00 +0000
description: "Mirai is a Raspberry Pi that never changed its factory password, the same hole a famous botnet drove a truck through, and the only puzzle worth the name is forensic recovery of a flag someone deleted."
image: /assets/og/the-password-was-printed-on-the-box.png
tags: [hackthebox, writeup]
---

Mirai is named after the botnet, and the botnet is named after the laziest mistake in computing. In 2016 a worm called Mirai ate a chunk of the internet by doing nothing clever at all. It walked up to hundreds of thousands of cameras and routers and tried the passwords printed in their manuals, and the devices, still wearing their factory logins, let it in. This box is that joke rebuilt in a lab. It is a Raspberry Pi running PiHole, and the Pi still answers to `pi` / `raspberry`, the default every Raspberry Pi ships with. You do not exploit Mirai. You log into it the way the manual tells you to, then `sudo` your way to root because the account was handed the keys to the whole house. The one moment that asks you to think comes at the very end, when the root flag turns out to be deleted, and you have to coax it back out of a USB stick that someone wiped.

```
        M I R A I
        =========
        a raspberry pi, blinking in a closet
        login:  pi
        pass:   raspberry          ( the factory default. never changed. )
                   |
                   v
        sudo -i  →  root, no questions asked
                   |
                   v
        root.txt:  "i lost it. check the usb stick."
        the stick was wiped. the bytes were not.
                                            糸
```

## 0x01 · the closet

`nmap -sC -sV` against the box paints a home-lab gadget, not a server. Six ports, and none of them are the usual enterprise furniture.

```
PORT      STATE SERVICE  VERSION
22/tcp    open  ssh      OpenSSH 6.7p1 Debian 5+deb8u3
53/tcp    open  domain   dnsmasq 2.76
80/tcp    open  http     lighttpd 1.4.35
1877/tcp  open  upnp     Platinum UPnP 1.0.5.13
32400/tcp open  http     Plex Media Server
32469/tcp open  upnp     Platinum UPnP 1.0.5.13
```

Read that list like a profile. `dnsmasq` on 53 is a DNS server. `lighttpd`, a lightweight web server people put on small devices. UPnP twice over, and a Plex media server on 32400. This is not a rack in a data center. This is somebody's Raspberry Pi sitting in a living room, doing ad-blocking and streaming movies. The version of Debian under it, Jessie, is old enough to tell the same story the rest of the fingerprint tells. Nobody has touched this thing since they set it up.

## 0x02 · the black hole

Browse to port 80 and the HTTP response carries a header that gives the whole game away.

```
# curl -I http://10.10.10.48/
HTTP/1.1 404 Not Found
X-Pi-hole: A black hole for Internet advertisements
```

`X-Pi-hole`. That is PiHole, the network-wide ad blocker that runs on, almost always, a Raspberry Pi. A quick directory brute with `feroxbuster` turns up `/admin`, the PiHole control panel, but it wants a password you do not have, and that is a dead end you should abandon fast. The web app is a distraction. The header already told you the only thing that matters. This is a Pi, and a Pi has a default account.

Think of it like reading the brand off an appliance before you try to open it. You do not need to pick the lock on a safe if the front of it says, in big letters, the manufacturer who ships every unit with the same combination. PiHole on a Raspberry Pi is that label. It tells you which factory key to try.

## 0x03 · the factory key

Every Raspberry Pi, for years, shipped with one user account already set up. Username `pi`, password `raspberry`. The idea was that you would change it the moment you booted the thing. Almost nobody did, and that single unchanged default is the exact hole the Mirai botnet drove a truck through. So you try it.

```
# ssh pi@10.10.10.48
pi@10.10.10.48's password: raspberry

pi@raspberrypi:~ $ id
uid=1000(pi) gid=1000(pi) groups=1000(pi),4(adm),20(dialout),...
pi@raspberrypi:~ $ cat user.txt
████████████████████████████████
```

That is the foothold. No exploit, no payload, no version-specific CVE. You typed the password that was printed in the manual, and the door opened. Picture a hotel that ships every room with the same key the locksmith cut at the factory, and a sign on the nightstand asking guests to please change the lock themselves. Most guests never read the sign. The whole botnet, and this whole foothold, is just walking the hallway trying that one factory key on every door.

## 0x04 · the keys to the house

Now look at what `pi` is actually allowed to do. The first thing to check on any Linux foothold is your `sudo` rights.

```
pi@raspberrypi:~ $ sudo -l
Matching Defaults entries for pi on localhost:
    env_reset, mail_badpass, ...

User pi may run the following commands on localhost:
    (ALL : ALL) ALL
    (ALL) NOPASSWD: ALL
```

`(ALL) NOPASSWD: ALL`. Read that twice, because it is the whole privilege escalation. The `pi` user is allowed to run any command, as any user, including root, and the `NOPASSWD` part means it will not even ask for a password to do it. There is nothing to escalate. The account already holds root, it just has not picked it up yet.

```
pi@raspberrypi:~ $ sudo -i
root@raspberrypi:~# id
uid=0(root) gid=0(root) groups=0(root)
```

This is the default on a fresh Raspberry Pi too, by the way. The factory `pi` account is meant to be a single-user owner of the device, so it gets passwordless `sudo` out of the box. On your own Pi behind your own router that is a convenience. Exposed to the internet with the default password still set, it means the first person to guess `raspberry` is instantly root. Think of it like a car where the ignition key and the key to the bank vault are the same key, and the car is parked unlocked. One turn does everything.

## 0x05 · the missing flag

Now the box earns its one moment of actual work. You go to read the root flag, and instead of a flag you find a confession.

```
root@raspberrypi:~# cat /root/root.txt
I lost my original root.txt! I think I may have a backup on my USB stick...
```

A USB stick. Listing the mounts shows it, an `ext4` partition on `/dev/sdb`, mounted at `/media/usbstick`. And on the stick, where the flag should be, another note.

```
root@raspberrypi:~# cat /media/usbstick/damnit.txt
Damnit! Sorry man I accidentally deleted your files off the USB stick.
Do you know if there is any way to get them back?
```

Deleted. This is the actual lesson of the box hiding under two breaths of trivial access, so it is worth getting right. When you delete a file on most filesystems, the bytes do not go anywhere. The system just crosses the file's name off an index and marks its space as available for reuse. The data sits there, an orphan with no label, until something else happens to write over it. Picture a library that loses a book not by burning it but by tearing the card out of the catalog. The book is still on the shelf. You just can no longer look it up by title. Until a new book gets shelved in that exact spot, the old one is sitting there in plain sight for anyone willing to walk the stacks.

So you walk the stacks. The cleanest move is to not trust the live device at all and instead pull the raw bytes off it. You read `/dev/sdb` block by block, compress the stream so it travels faster, and catch it on your own machine.

```
# ssh pi@10.10.10.48 "sudo dd if=/dev/sdb | gzip -1 -" | gzip -d > usb.img
```

Now you have a perfect copy of the whole stick, deleted regions and all, sitting in `usb.img` where no further writes can ever overwrite the orphaned blocks. From here the laziest method works first. A flag is 32 hex characters, so just sweep the raw image for that pattern.

```
# grep -aPo '[a-fA-F0-9]{32}' usb.img
████████████████████████████████
```

There it is. The deleted root flag, pulled straight out of unallocated space, because deletion only tore out the catalog card and never touched the book. If you want the forensically tidy version rather than the smash-and-grab, `extundelete` knows how to read the `ext4` journal and rebuild deleted files by name.

```
# extundelete usb.img --restore-all
# cat RECOVERED_FILES/root.txt
████████████████████████████████
```

Same flag, recovered properly, file and all. Either way the stick gave back exactly what someone thought they had thrown away.

## 0x06 · the honest caveat

It is easy to read Mirai as a museum piece. Default Raspberry Pi credentials got patched out years ago. Newer Pi images refuse to boot until you set a real password, exactly because of the botnet this box is named after. The specific hole is closed. But the shape of it is everywhere, and it has nothing to do with Raspberry Pis.

The shape is this. A device ships with a known secret, the buyer is trusted to change it, and the buyer never does. That is your router. That is the camera over your front door, the printer in the office, the smart plug, the network video recorder, the industrial controller running a pump somewhere. Every one of them leaves a factory with a password a stranger can look up, and every one of them is one un-changed default away from belonging to whoever finds it first. Mirai the botnet did not break anything. It read the manual. The single most powerful tool in that whole attack was a list of default logins, and that list still works on more of the internet than anyone wants to admit.

And keep the deleted flag in mind, because it carries its own warning aimed the other direction. Deleting a file is not erasing it. The note on the stick says the files are gone, and they were not gone at all, they were sitting one `grep` away. When you sell a laptop, hand off a phone, or toss a USB stick, "I deleted everything" means the catalog card is missing and the book is still on the shelf for the next person. The flag came back because deletion is a lie we tell ourselves about data. The data outlives the decision to be rid of it.

## 0x07 · outro

```
the password was printed in the manual.
nobody changed it, so the door was never really locked.
the account already held root. it only had to reach for it.

and the flag they swore they deleted
        was still lying in the dark, waiting to be read.

change the default. wipe the disk. wear black.

                                                            EOF
```

---

*HTB: Mirai, retired 10 Feb 2018. An easy Linux box that is really a lecture on the factory password, wearing the costume of the botnet that made that lecture famous. The deleted flag still answers to a grep in a lab and nowhere you do not own.*