module a;
  import p1::f;
  initial x = f();
endmodule

module b;
  import p2::f;
  initial y = f();
endmodule
