package main

import (
	cryptoRand "crypto/rand"
	"encoding/binary"
)

func randomStr(l int) string {
	ret := ""
	const dict = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.,"
	tmpbuf := make([]byte, 1)
	for i := 0; i < l; i++ {
		n, err := cryptoRand.Read(tmpbuf)
		if err != nil {
			panic(err)
		}
		if n != 1 {
			panic("n != 1")
		}
		ret += string(dict[int(tmpbuf[0])%len(dict)])
	}
	return ret
}

func randomU32() uint32 {
	tmpbuf := make([]byte, 4)
	n, err := cryptoRand.Read(tmpbuf)
	if err != nil {
		panic(err)
	}
	if n != 4 {
		panic("n != 4")
	}
	return binary.LittleEndian.Uint32(tmpbuf)
}
