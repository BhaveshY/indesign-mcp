"""Minimal late-bound COM client (ctypes only) for InDesign's DoScript.

Only what the server needs: attach/launch InDesign.Application and invoke a
method or property with string/int arguments, returning str/int/float/bool.
"""
import ctypes
from ctypes import (POINTER, Structure, Union, byref, c_double, c_long, c_longlong,
                    c_short, c_ubyte, c_uint, c_ulong, c_ushort, c_void_p, c_wchar_p)

ole32 = ctypes.WinDLL("ole32")
oleaut32 = ctypes.WinDLL("oleaut32")

VT_EMPTY, VT_I4, VT_R8, VT_BSTR, VT_DISPATCH, VT_ERROR, VT_BOOL = 0, 3, 5, 8, 9, 10, 11
VT_I2, VT_R4, VT_I8, VT_UI4, VT_INT = 2, 4, 20, 19, 22
DISPATCH_METHOD, DISPATCH_PROPERTYGET = 1, 2
DISP_E_EXCEPTION = -2147352567
RPC_E_CALL_REJECTED = -2147418111
RPC_E_SERVERCALL_RETRYLATER = -2147417846
BUSY_CODES = {RPC_E_CALL_REJECTED, RPC_E_SERVERCALL_RETRYLATER}
GONE_CODES = {-2147023174, -2147023170, -2147417848, -2147220995}  # RPC server unavailable / disconnected
MK_E_UNAVAILABLE = -2147221021


class GUID(Structure):
    _fields_ = [("d1", c_ulong), ("d2", c_ushort), ("d3", c_ushort), ("d4", c_ubyte * 8)]


class _VU(Union):
    _fields_ = [("llVal", c_longlong), ("lVal", c_long), ("dblVal", c_double), ("fltVal", ctypes.c_float),
                ("boolVal", c_short), ("ptr", c_void_p), ("rec", c_void_p * 2)]


class VARIANT(Structure):
    _fields_ = [("vt", c_ushort), ("r1", c_ushort), ("r2", c_ushort), ("r3", c_ushort), ("u", _VU)]


class DISPPARAMS(Structure):
    _fields_ = [("rgvarg", POINTER(VARIANT)), ("rgdispidNamedArgs", POINTER(c_long)),
                ("cArgs", c_uint), ("cNamedArgs", c_uint)]


class EXCEPINFO(Structure):
    _fields_ = [("wCode", c_ushort), ("wReserved", c_ushort), ("bstrSource", c_void_p),
                ("bstrDescription", c_void_p), ("bstrHelpFile", c_void_p), ("dwHelpContext", c_ulong),
                ("pvReserved", c_void_p), ("pfnDeferredFillIn", c_void_p), ("scode", c_long)]


oleaut32.SysAllocStringLen.restype = c_void_p
oleaut32.SysAllocStringLen.argtypes = [c_wchar_p, c_uint]
oleaut32.SysStringLen.restype = c_uint
oleaut32.SysStringLen.argtypes = [c_void_p]
oleaut32.SysFreeString.argtypes = [c_void_p]
oleaut32.VariantClear.argtypes = [POINTER(VARIANT)]
oleaut32.GetActiveObject.argtypes = [POINTER(GUID), c_void_p, POINTER(c_void_p)]
oleaut32.GetActiveObject.restype = c_long
ole32.CLSIDFromProgID.argtypes = [c_wchar_p, POINTER(GUID)]
ole32.CLSIDFromProgID.restype = c_long
ole32.CoCreateInstance.argtypes = [POINTER(GUID), c_void_p, c_ulong, POINTER(GUID), POINTER(c_void_p)]
ole32.CoCreateInstance.restype = c_long
ole32.CoInitializeEx.argtypes = [c_void_p, c_ulong]
ole32.CoInitializeEx.restype = c_long

IID_NULL = GUID()
IID_IDispatch = GUID(0x00020400, 0, 0, (c_ubyte * 8)(0xC0, 0, 0, 0, 0, 0, 0, 0x46))

_QI = ctypes.WINFUNCTYPE(c_long, c_void_p, POINTER(GUID), POINTER(c_void_p))
_REL = ctypes.WINFUNCTYPE(c_ulong, c_void_p)
_GIDS = ctypes.WINFUNCTYPE(c_long, c_void_p, POINTER(GUID), POINTER(c_wchar_p), c_uint, c_ulong, POINTER(c_long))
_INV = ctypes.WINFUNCTYPE(c_long, c_void_p, c_long, POINTER(GUID), c_ulong, c_ushort,
                          POINTER(DISPPARAMS), POINTER(VARIANT), POINTER(EXCEPINFO), POINTER(c_uint))


class ComError(Exception):
    def __init__(self, hr, msg=""):
        self.hr = hr
        super().__init__(msg or f"COM error 0x{hr & 0xFFFFFFFF:08X}")

    @property
    def busy(self):
        return self.hr in BUSY_CODES

    @property
    def gone(self):
        return self.hr in GONE_CODES


def _bstr_to_str(p):
    if not p:
        return ""
    return ctypes.wstring_at(p, oleaut32.SysStringLen(p))


def init_thread():
    ole32.CoInitializeEx(None, 2)  # STA


class Dispatch:
    def __init__(self, ptr):
        self.ptr = ptr
        self._vt = ctypes.cast(ptr, POINTER(POINTER(c_void_p)))[0]
        self._ids = {}

    def __del__(self):
        try:
            if self.ptr:
                _REL(self._vt[2])(self.ptr)
                self.ptr = None
        except Exception:
            pass

    def _dispid(self, name):
        if name not in self._ids:
            names = (c_wchar_p * 1)(name)
            did = c_long()
            hr = _GIDS(self._vt[5])(self.ptr, byref(IID_NULL), names, 1, 0, byref(did))
            if hr < 0:
                raise ComError(hr, f"Unknown member {name}")
            self._ids[name] = did.value
        return self._ids[name]

    def _invoke(self, name, flags, args):
        did = self._dispid(name)
        n = len(args)
        arr = (VARIANT * max(n, 1))()
        bstrs = []
        for i, a in enumerate(reversed(args)):
            v = arr[i]
            if isinstance(a, bool):
                v.vt, v.u.boolVal = VT_BOOL, -1 if a else 0
            elif isinstance(a, int):
                v.vt, v.u.lVal = VT_I4, a
            elif isinstance(a, float):
                v.vt, v.u.dblVal = VT_R8, a
            elif a is None:
                v.vt, v.u.lVal = VT_ERROR, -2147352572  # DISP_E_PARAMNOTFOUND: optional arg omitted
            else:
                s = str(a)
                b = oleaut32.SysAllocStringLen(s, len(s))
                bstrs.append(b)
                v.vt, v.u.ptr = VT_BSTR, b
        dp = DISPPARAMS(arr if n else None, None, n, 0)
        res = VARIANT()
        exc = EXCEPINFO()
        argerr = c_uint()
        try:
            hr = _INV(self._vt[6])(self.ptr, did, byref(IID_NULL), 0, flags, byref(dp), byref(res), byref(exc), byref(argerr))
        finally:
            for b in bstrs:
                oleaut32.SysFreeString(b)
        if hr < 0:
            msg = ""
            if hr == DISP_E_EXCEPTION:
                msg = _bstr_to_str(exc.bstrDescription)
                for b in (exc.bstrSource, exc.bstrDescription, exc.bstrHelpFile):
                    if b:
                        oleaut32.SysFreeString(b)
                if exc.scode:
                    hr2 = exc.scode
                    if hr2 in BUSY_CODES or hr2 in GONE_CODES:
                        hr = hr2
            raise ComError(hr, msg)
        self.last_vt = res.vt   # kept for diagnostics of unexpected result types
        try:
            return self._value(res)
        finally:
            if res.vt != VT_DISPATCH:
                oleaut32.VariantClear(byref(res))

    @staticmethod
    def _value(v):
        vt = v.vt
        if vt == VT_BSTR:
            return _bstr_to_str(v.u.ptr)
        if vt in (VT_I4, VT_INT, VT_UI4):
            return v.u.lVal
        if vt == VT_I2:
            return v.u.boolVal
        if vt == VT_I8:
            return v.u.llVal
        if vt == VT_R8:
            return v.u.dblVal
        if vt == VT_R4:
            return v.u.fltVal
        if vt == VT_BOOL:
            return v.u.boolVal != 0
        if vt == VT_DISPATCH:
            return Dispatch(v.u.ptr) if v.u.ptr else None
        return None

    def call(self, name, *args):
        return self._invoke(name, DISPATCH_METHOD, list(args))

    def get(self, name):
        return self._invoke(name, DISPATCH_PROPERTYGET, [])


def _clsid(progid):
    clsid = GUID()
    hr = ole32.CLSIDFromProgID(progid, byref(clsid))
    if hr < 0:
        raise ComError(hr, f"{progid} is not registered")
    return clsid


def _as_dispatch(punk):
    vt = ctypes.cast(punk, POINTER(POINTER(c_void_p)))[0]
    out = c_void_p()
    hr = _QI(vt[0])(punk, byref(IID_IDispatch), byref(out))
    _REL(vt[2])(punk)
    if hr < 0:
        raise ComError(hr, "No IDispatch")
    return Dispatch(out.value)


def attach(progids):
    """Return Dispatch for a running instance, or None if none is running."""
    for pid in progids:
        try:
            clsid = _clsid(pid)
        except ComError:
            continue
        punk = c_void_p()
        hr = oleaut32.GetActiveObject(byref(clsid), None, byref(punk))
        if hr >= 0 and punk.value:
            return _as_dispatch(punk.value)
    return None


def launch(progids):
    last = None
    for pid in progids:
        try:
            clsid = _clsid(pid)
        except ComError as e:
            last = e
            continue
        out = c_void_p()
        hr = ole32.CoCreateInstance(byref(clsid), None, 4, byref(IID_IDispatch), byref(out))  # CLSCTX_LOCAL_SERVER
        if hr >= 0:
            return Dispatch(out.value)
        last = ComError(hr, f"Could not start {pid}")
    raise last or ComError(-1, "InDesign is not registered")
