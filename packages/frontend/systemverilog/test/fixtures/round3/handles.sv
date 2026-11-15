class C;
  int v;
  function new(int a = 0);
    v = a;
  endfunction
  task m();
  endtask
endclass

module handles_mod;
  C c1;
  C c2;
  int k;
  C c3;
  C arr[4];
  initial begin
    c1 = new();
    c2 = new(1);
    c2.m();
    c3 = C::new(3);
    arr[0] = new(2);
  end
endmodule
