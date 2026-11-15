function int g();
  return 0;
endfunction

module d;
  import p3::*;
  initial x = g();
endmodule
