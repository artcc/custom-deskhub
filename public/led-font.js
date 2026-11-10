/*
 * MD_MAX72XX printable ASCII bitmap font (USE_NEW_FONT).
 * Copyright (C) 2012-14 Marco Colli. All rights reserved.
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Modified 2026-11-10: extracted ASCII 32..126 from the new font table,
 * removed width prefixes and converted unchanged columns to JavaScript arrays.
 * Source: https://github.com/MajicDesigns/MD_MAX72XX/blob/b852c70328f30a11ca2bd36149f18379feaddea2/src/MD_MAX72xx_font.cpp
 * License: ./licenses/MD_MAX72XX-LGPL-2.1.txt
 *
 * This library is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * This library is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with this library; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin St, Fifth Floor, Boston, MA 02110-1301 USA.
 */

// Indexed by ASCII code minus 32; columns run left to right, bit 0 is the top row.
export const FONT = [
  [0, 0], // 32 space
  [95], // 33 !
  [7, 0, 7], // 34 "
  [20, 127, 20, 127, 20], // 35 #
  [68, 74, 255, 74, 50], // 36 $
  [99, 19, 8, 100, 99], // 37 %
  [54, 73, 73, 54, 72], // 38 &
  [7], // 39 '
  [62, 65, 65], // 40 (
  [65, 65, 62], // 41 )
  [8, 42, 28, 42, 8], // 42 *
  [8, 8, 62, 8, 8], // 43 +
  [96, 224], // 44 ,
  [8, 8, 8, 8], // 45 -
  [96, 96], // 46 .
  [96, 16, 8, 4, 3], // 47 /
  [62, 81, 73, 69, 62], // 48 0
  [4, 2, 127], // 49 1
  [113, 73, 73, 73, 70], // 50 2
  [65, 73, 73, 73, 54], // 51 3
  [15, 8, 8, 8, 127], // 52 4
  [79, 73, 73, 73, 49], // 53 5
  [62, 73, 73, 73, 48], // 54 6
  [3, 1, 1, 1, 127], // 55 7
  [54, 73, 73, 73, 54], // 56 8
  [6, 73, 73, 73, 62], // 57 9
  [108, 108], // 58 :
  [108, 236], // 59 ;
  [8, 20, 34], // 60 <
  [20, 20, 20, 20], // 61 =
  [34, 20, 8], // 62 >
  [1, 89, 9, 9, 6], // 63 ?
  [62, 65, 93, 89, 78], // 64 @
  [126, 9, 9, 9, 126], // 65 A
  [127, 73, 73, 73, 54], // 66 B
  [62, 65, 65, 65, 65], // 67 C
  [127, 65, 65, 65, 62], // 68 D
  [127, 73, 73, 73, 65], // 69 E
  [127, 9, 9, 9, 1], // 70 F
  [62, 65, 65, 73, 121], // 71 G
  [127, 8, 8, 8, 127], // 72 H
  [65, 127, 65], // 73 I
  [48, 65, 65, 65, 63], // 74 J
  [127, 8, 20, 34, 65], // 75 K
  [127, 64, 64, 64, 64], // 76 L
  [127, 2, 12, 2, 127], // 77 M
  [127, 4, 8, 16, 127], // 78 N
  [62, 65, 65, 65, 62], // 79 O
  [127, 9, 9, 9, 6], // 80 P
  [62, 65, 65, 97, 126], // 81 Q
  [127, 9, 25, 41, 70], // 82 R
  [70, 73, 73, 73, 49], // 83 S
  [1, 1, 127, 1, 1], // 84 T
  [63, 64, 64, 64, 63], // 85 U
  [31, 32, 64, 32, 31], // 86 V
  [63, 64, 56, 64, 63], // 87 W
  [99, 20, 8, 20, 99], // 88 X
  [3, 4, 120, 4, 3], // 89 Y
  [97, 81, 73, 69, 67], // 90 Z
  [127, 65, 65], // 91 [
  [3, 4, 8, 16, 96], // 92 backslash
  [65, 65, 127], // 93 ]
  [4, 2, 1, 2, 4], // 94 ^
  [128, 128, 128, 128], // 95 _
  [1, 2, 4], // 96 `
  [56, 68, 68, 124], // 97 a
  [127, 68, 68, 56], // 98 b
  [56, 68, 68, 68], // 99 c
  [56, 68, 68, 127], // 100 d
  [56, 84, 84, 88], // 101 e
  [4, 126, 5, 1], // 102 f
  [24, 164, 164, 124], // 103 g
  [127, 4, 4, 120], // 104 h
  [125], // 105 i
  [132, 133, 124], // 106 j
  [127, 16, 40, 68], // 107 k
  [127], // 108 l
  [124, 4, 120, 4, 120], // 109 m
  [124, 4, 4, 120], // 110 n
  [56, 68, 68, 56], // 111 o
  [252, 36, 36, 24], // 112 p
  [24, 36, 36, 252], // 113 q
  [124, 4, 4, 8], // 114 r
  [88, 84, 84, 52], // 115 s
  [4, 127, 4], // 116 t
  [60, 64, 64, 124], // 117 u
  [28, 32, 64, 124], // 118 v
  [60, 64, 48, 64, 60], // 119 w
  [108, 16, 16, 108], // 120 x
  [28, 160, 160, 124], // 121 y
  [100, 84, 84, 76], // 122 z
  [8, 54, 65, 65], // 123 {
  [127], // 124 |
  [65, 65, 54, 8], // 125 }
  [2, 1, 2, 1] // 126 ~
];
