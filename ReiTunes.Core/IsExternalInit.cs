// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

using System.ComponentModel;

// Reilly: this is a hack to enable records in pre-5 runtimes
// https://medium.com/@SergioPedri/enabling-and-using-c-9-features-on-older-and-unsupported-runtimes-ce384d8debb

namespace System.Runtime.CompilerServices
{

    /// <summary>
    /// Reserved to be used by the compiler for tracking metadata.
    /// This class should not be used by developers in source code.
    /// </summary>
    [EditorBrowsable(EditorBrowsableState.Never)]
    internal static class IsExternalInit
    {
    }
}