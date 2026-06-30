---
layout: post
title: "The Envelope That Fetched Itself"
subtitle: "HTB Encoding, where a file-fetching API reads its own secrets, a git repo spills the blueprints, and a chain of small trusts walks you up to root"
date: 2023-04-22 12:00:00 +0000
description: "A file-fetching API that will read anything you name, a leaked git repo, and a privilege chain built entirely out of small trusts nobody locked."
image: /assets/og/the-envelope-that-fetched-itself.png
tags: [hackthebox, writeup]
---

Encoding is a box about a helpful little tool that fetches files for you. You give it a URL, it grabs whatever is on the other end, and it hands the contents back encoded however you asked. That is the whole pitch, and it is also the whole wound. Because the tool never stops to ask whether the URL points at the wide internet or at the inside of its own house. Tell it `file:///etc/passwd` and it walks down its own hallway and reads you the locked drawer. From there the box is a relay race of small, reasonable-looking trusts, each one handing the baton to the next: a leaked git repo, a request the server makes on your behalf, a commit hook that runs as someone better than you, and a service file that runs as the best account on the machine. Nobody forces a single door. Every one of them was held open from the inside.

```
        H A X T A B L E S
        =================
        "give me a url, i'll fetch it
         and read it back to you"
                |
        file://  ?   sure. one moment.
                |
                v
        the clerk walks to his OWN filing cabinet,
        opens the drawer marked PRIVATE,
        and reads it aloud to a stranger.

        then the stranger asks him to mail a letter.
        he does. the letter was to himself.
                                            印
```

## 0x01 · the storefront

Two ports answer, which is its own kind of statement. A box that opens with `nmap -sC -sV` and shows you only SSH and a web server is telling you the entire game lives in HTTP.

```
PORT   STATE SERVICE VERSION
22/tcp open  ssh     OpenSSH 8.9p1 Ubuntu
80/tcp open  http    Apache httpd 2.4.52 (Ubuntu)
```

The site is `haxtables.htb`, a toolbox for converting strings between encodings, hex and base64 and the rest. Fuzz for virtual hosts and two more faces appear behind the same IP. `wfuzz` against the Host header, filtering by response size to cut the noise, turns up `api.haxtables.htb` and `image.haxtables.htb`. Picture an office building with one street address and three doors. The main door is for customers, the API door is staff-only, and the image door is locked entirely. The lock on that third door is the thing the rest of the box exists to pick.

## 0x02 · the clerk who reads his own files

The conversion tools post JSON to the API, and one field is the tell. Alongside the text you want converted, there is a `file_url` parameter. Hand a web app a parameter whose entire job is to go fetch a file, and your ears should prick up, because the question is always the same: fetch a file from *where*, and who decided what counts as a valid where.

```
POST /v3/tools/string/index.php
{"action":"str2hex","file_url":"http://10.10.14.4/test"}
```

It really does reach back to your server and pull the file. So it speaks the language of URLs. The thing about URLs is that `http://` is not the only dialect. Swap the scheme for `file://` and you are no longer asking it to fetch from the network. You are asking it to fetch from its own disk.

```
{"action":"str2hex","file_url":"file:///etc/passwd"}
```

Back comes the hex of `/etc/passwd`. This is server-side request forgery in its purest, most literal form. Think of it like handing a hotel concierge an address and asking him to go pick up a package. You expected him to walk to the street. Instead the address you wrote was *his own back office*, and he is too polite to notice the difference. He fetches what you named because fetching is his job, and `file:///` is a perfectly valid place to fetch from as far as the underlying library is concerned. Wrap a tiny proxy around this so every local file is one HTTP request away, and you now have read access to the box's filesystem through a string-conversion toy.

## 0x03 · the blueprints in the back room

A file read is a flashlight, not a key. The trick is knowing where to point it. That locked `image.haxtables.htb` door has to live somewhere on disk, and Apache vhosts on Ubuntu are predictable. Read the site config, find the docroot at `/var/www/image`, and probe for the thing developers leave behind more often than they would ever admit: a `.git` directory sitting in the web root.

```
GET /file?path=file:///var/www/image/.git/HEAD   ->   ref: refs/heads/master
```

It is there. A `.git` folder is the entire history of a codebase, every file, every version, written to disk in a known layout. Picture an architect who threw the building's blueprints in the dumpster out back without shredding them. You cannot walk through the locked front door, but you can read exactly how the locks were built. With file read over the proxy, point `git-dumper` at it and reconstruct the whole repository object by object.

```
$ git-dumper http://127.0.0.1:8000/var/www/image/.git ./image_src
$ git log --oneline
```

Now the locked door has glass walls. Inside the source, three things matter. An `action_handler.php` that includes a file path you can influence. A `utils.php` with a `make_api_call()` that builds a URL out of user input. And a `scripts/git-commit.sh` referenced in a way that smells like sudo. Read those in order and the rest of the box draws itself.

## 0x04 · the letter the server mailed to itself

The `make_api_call()` function glues your input into a URL and then fetches it, server-side.

```php
$url = 'http://api.haxtables.htb' . $uri_path . '/index.php';
```

It tries to validate `$uri_path` with PHP's `parse_url()` first, which feels safe and is not. `parse_url()` is famously loose. Feed it a string with no clean scheme and it parses the pieces wrong, deciding the host is something other than what a browser would conclude. That gap between "what the validator thinks this URL means" and "what the fetch library thinks it means" is the whole exploit. Think of it like two clerks reading the same sloppy handwriting on an envelope. One reads the address as the post office, approves it, and stamps it. The other actually delivers it, reads the same scrawl, and walks it somewhere else entirely. You write one envelope that two readers disagree about on purpose.

Abuse that disagreement and you steer the server's outbound request to the locked `image` host, the one you could never reach from outside. The server can reach it. You are now making requests *as the server*, from inside its own network, at the door marked staff-only.

What lives behind that door is `action_handler.php` and its unsafe `include($page)`. An include that runs whatever file you name is remote code execution waiting for a delivery method, and PHP hands you an exotic one. You do not need to upload a file anywhere. PHP filter chains let you build executable code out of nothing but a stack of encoding conversions applied to an empty stream. Each `convert.iconv` filter nudges the bytes, and stacked in the right order they assemble a payload out of thin air.

```
php://filter/convert.iconv.UTF8.CSISO2022KR|...|convert.base64-decode/resource=php://temp
```

Generate the chain with `php_filter_chain_generator.py`, feed it through the SSRF into the vulnerable include, and the server constructs your code character by character and then runs it. Picture a ransom note assembled from magazine letters, except the letters are encodings and the note is a shell. Land the reverse shell and the prompt comes back as `www-data`.

```
$ nc -lvnp 443
connect to [10.10.14.4] from (UNKNOWN) [10.10.11.198]
$ id
uid=33(www-data) gid=33(www-data)
$ [ reverse shell delivered via the filter chain through the SSRF ]
```

## 0x05 · the commit that ran as somebody better

`www-data` is a doormat account, so check `sudo -l` and read what the box is willing to let it do.

```
User www-data may run the following commands on encoding:
    (svc) NOPASSWD: /var/www/image/scripts/git-commit.sh
```

You can run a git commit script as the user `svc`, with no password. On its own that sounds harmless. It is not, because of how git works. Every git repository can carry hooks, little scripts git runs automatically at certain moments, and `post-commit` runs immediately after a commit lands. Crucially, the hook runs as whoever performed the commit. The commit script runs as `svc`, so the hook runs as `svc`.

Thanks to a loose ACL, `www-data` can write inside that repo's `.git` directory. So you drop your own `post-commit` hook, make it executable, stage a throwaway change, and then ask the box to commit as `svc`.

```
$ cat .git/hooks/post-commit
#!/bin/bash
[ write an ssh key into /home/svc/.ssh/authorized_keys ]
$ chmod +x .git/hooks/post-commit
$ sudo -u svc /var/www/image/scripts/git-commit.sh
```

The commit fires as `svc`, the hook fires as `svc`, and your hook plants an SSH key in `svc`'s account. Think of it like a clerk who is allowed to stamp documents on the manager's behalf, except you slipped a note into the stamp pad that says "and also give this man a key to the manager's office." The stamp comes down, the note runs, and now you SSH in as `svc` and read the user flag.

```
$ ssh -i iceberg_ed25519 svc@10.10.11.198
svc@encoding:~$ cat user.txt
████████████████████████████████
```

## 0x06 · the service that ran as root

One pivot left. Check `svc`'s sudo rights and the box shows its hand with a single dangerous character.

```
User svc may run the following commands on encoding:
    (root) NOPASSWD: /usr/bin/systemctl restart *
```

That asterisk is the whole bug. `svc` can restart *any* systemd service as root. systemd decides what a service does by reading a unit file in `/etc/systemd/system`, and that unit file says, in plain text, which program to run. So the question becomes: can you write a unit file describing a service that runs your code. Another generous ACL says yes, `svc` has write access into that directory.

So you author a service that points its `ExecStart` at a script you control, then use your one sudo right to restart it.

```
[Service]
Type=simple
ExecStart=/tmp/iceberg-root.sh
```

```
svc@encoding:~$ sudo /usr/bin/systemctl restart iceberg
```

systemd reads the unit, sees `ExecStart`, and dutifully runs your script as root, because running services is exactly what systemd is for. The script plants an SSH key for root, or flips a SUID bit, whatever you like. Think of it like a building manager who restarts the machinery whenever a maintenance worker asks. The worker is only allowed to flip the switch, never to rewire anything. But the wiring diagram is taped to a wall the worker can reach with a pencil. He redraws what the machine does, flips his one permitted switch, and the machine obeys the new diagram. The switch was the only thing he was trusted with. It turned out to be enough.

```
svc@encoding:~$ ssh -i iceberg_root_ed25519 root@127.0.0.1
root@encoding:~# cat /root/root.txt
████████████████████████████████
```

## 0x07 · the honest caveat

Not one step on Encoding is a memory corruption magic trick or a named CVE. Every single move is a feature working exactly as built, pointed somewhere it was never meant to point. The fetch tool fetched. The validator validated, badly. The include included. Git ran its hook. systemd ran its service. None of these is a bug in the narrow sense. They are bugs in the gap between what a thing *can* do and what its author *imagined* it doing.

The thread tying all six sections together is trust that forgot to name a boundary. The file-fetcher trusted that a URL points outward. `parse_url()` and the HTTP client trusted that they agreed on what an envelope said. The repo trusted that anyone who could commit was allowed to plant a hook. systemd trusted that anyone who could restart a service was allowed to define one. Each trust was reasonable in isolation. Stacked, they form a clean staircase from a string-conversion toy to root, and the attacker never did anything more violent than ask politely.

The two steps that should keep an engineer up at night are the SSRF and the sudo wildcard, because both ship green. There is nothing to patch. The fetcher needs an allowlist of schemes and hosts, a hard rule that says outward means outward. The sudo line needs to lose its asterisk, because a wildcard in a privileged command is a blank check signed in advance. You cannot `apt upgrade` your way out of either. Only someone drawing the boundary by hand fixes them.

## 0x08 · outro

```
the tool fetched the file because fetching was its whole purpose.
nobody told it that "inside" was a place it could reach.

the repo spilled because the blueprints went out with the trash.
the commit ran as a better man because the hook never checked who asked.
the service ran as root because a wildcard signed the check in advance.

six small trusts, end to end, and not one door was forced.

name the boundary. kill the wildcard. wear black.

                                                            EOF
```

---

*HTB: Encoding, retired 15 Apr 2023. A medium Linux box that is really a lecture on server-side request forgery and the danger of a trust with no edge. The fetcher still reads its own filing cabinet in a lab and nowhere you don't own.*