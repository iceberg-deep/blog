---
layout: post
title: "Still Has the Key"
subtitle: "HTB LittleTommy, a use-after-free explained plainly. The account you deleted still answers the door."
date: 2017-12-10 12:00:00 +0000
description: "A tiny account-manager binary with one fatal habit. It frees memory but keeps pointing at it, so the thing you deleted is still trusted. Delete an account, move new data into its old slot, and the program reads your data as the account. A use-after-free, start to finish."
image: /assets/og/still-has-the-key.png
tags: [hackthebox, reversing, pwn, use-after-free, writeup]
---

LittleTommy is a small binary that manages bank accounts, and it has one fatal habit. It lets go of memory without forgetting where that memory was. You delete an account and the program keeps pointing at the empty slot as if your account were still living there. So you move new data into the slot, and the program happily reads your new data as if it were the account it deleted a moment ago. That bug has a name, use-after-free, and this is the cleanest place I know to actually understand it.

```
        L I T T L E   T O M M Y
        =======================
        create acct   ->  room 72 is yours
        delete acct   ->  you check out, BUT
                          the front desk still
                          lists room 72 as yours
        add memo      ->  new guest moves into room 72
        print flag    ->  desk reads the new guest's
                          graffiti as YOUR balance
                                            鍵
```

## 0x01 · what the program does

Run the binary and you get a five-option menu for a toy bank. Create an account, display it, delete it, add a memo, and print the flag. Under the hood the shape is simple. Creating an account asks `malloc` for 72 bytes on the heap and stores a pointer to that block in a global called `main_account`. The first 32 bytes hold a first name, the next 32 hold a last name, and the final 8 bytes hold the balance.

The flag option is the prize. It prints the flag only if an account exists and the 8 bytes near the end of the account block equal `0x6b637566`. Read that value as ASCII, little-endian, and it spells a word the author clearly enjoyed. Our entire job is to get those 8 bytes to hold that value, even though the menu never lets us type it into the balance.

## 0x02 · the habit that kills it

Look at the delete option. It calls `free` on the account block, which hands that memory back to the allocator. The bug is what it does not do next. It never sets `main_account` back to null. The pointer keeps aiming at a block the program no longer owns. That stale pointer has a name too, a dangling pointer, and it is the whole vulnerability.

Here is the part worth slowing down for, because it is the heart of every use-after-free in the world.

Picture a hotel. Creating the account checks you into room 72. Deleting the account checks you out, so the room is free for the next guest. But the front desk's guest list still has your name written next to room 72, because nobody erased it. That is the dangling pointer. The room is empty and available, yet the records insist it is still yours.

Now a new guest arrives, and the hotel gives them the first free room, which is room 72. They scribble all over the walls. When someone asks the front desk "what does the guest in room 72 say," the desk reads the new guest's graffiti and reports it as if it came from you. The program trusts its own records. The records are a lie.

## 0x03 · moving new data into the dead slot

The "add memo" option is the new guest. It takes input from you and writes it onto the heap, and the allocator, being thrifty, hands back the most recently freed block of the right size. That block is the one we just freed. So the bytes we type as a memo land exactly where the account used to live, including those 8 bytes the flag check cares about.

The plan writes itself. Create an account so a block exists and `main_account` points at it. Delete it so the block is freed but `main_account` still points there. Add a memo long enough that its bytes cover all 72 bytes of the old block, with the magic value sitting in the right spot near the end. Then ask for the flag. The account "still exists" as far as the program is concerned, because the dangling pointer never went null, and the freed slot now holds our forged balance.

## 0x04 · the proof of concept

Sixty-four filler bytes carry us up to the balance field, then the four bytes that spell the magic word. The allocator reuses the freed chunk, the forged value lands where the check looks, and option five reads it back as a real account.

```
from pwn import *

io = remote("littletommy.htb", 1337)

def menu(n):
    io.recvuntil(b"operation number:")
    io.sendline(str(n).encode())

# 1) create an account (names can be blank)
menu(1)
io.sendline(b"")          # first name
io.sendline(b"")          # last name

# 3) delete it -> block is freed, main_account still points at it
menu(3)

# 4) add a memo -> reuses the freed block, overwrites the balance bytes
menu(4)
io.sendline(b"A"*64 + b"fuck")

# 5) print the flag -> dead account, forged balance, condition true
menu(5)
io.interactive()
```

Out comes the flag, written into the corpse of an account that was deleted three steps ago.

## 0x05 · the honest caveat

Use-after-free sounds like a deep wizard problem, and at the top end it absolutely is. Browser and kernel exploits chain dozens of these into full code execution. LittleTommy strips it down to the one idea underneath all of that. The danger is never the `free` itself. The danger is keeping a pointer to something you gave back, then trusting it later as if nothing changed.

The fix is one line, the line this binary forgot. After you free a pointer, set it to null, so the next time anyone reaches for it the program crashes honestly instead of reading a stranger's data. Modern allocators and hardened builds add their own seatbelts, but the discipline is the real defense. Let go of a thing and let go of the pointer too. Half-remembering is worse than forgetting.

## 0x06 · outro

```
you deleted the account. the program kept its number.
a new tenant moved in and wrote on the walls.
the program read the walls and called it your balance.

free the memory, then forget where it was. a pointer to the dead is a door left open.

null your frees. doubt your records. wear black.

                                                            EOF
```

---

*HTB: LittleTommy, a reversing challenge retired 03 Dec 2017. A pocket-sized use-after-free, and the friendliest one you will ever read.*
